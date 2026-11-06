
from __future__ import annotations

import contextlib
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    DETECTOR_POSE_AVAILABLE,
    RUNTIME_CUDA_FAILURES,
    RUNTIME_CUDA_RECOVERED,
    RUNTIME_DEGRADED,
)
# Batched detection support is optional — we tolerate insightface API drift
# by falling back to the per-image path when BatchedSCRFD can't be built.
# BatchedSCRFD imports FaceObservation from this module, so we defer its
# import to the first batched-detect call to break the circular dependency.
from vms_face.infra.batcher import AsyncBatcher

log = get_logger(__name__)


_CUDA_FAIL_TOKENS = ("CUDA", "CUBLAS", "cuDNN", "CUDNN", "cudaMalloc", "cudaError")


def _is_cuda_failure(exc: BaseException) -> bool:
    """Best-effort detection of CUDA-execution-provider failures.

    ORT raises a variety of exception types for CUDA hiccups (RuntimeError,
    onnxruntime.capi.onnxruntime_pybind11_state.Fail, etc.) and the message is
    the only reliable carrier. Token list is conservative — false negatives
    are preferable to false positives because a non-CUDA bug we hide behind a
    CUDA-fallback latch is much harder to debug than a loud failure."""
    msg = str(exc)
    return any(tok in msg for tok in _CUDA_FAIL_TOKENS)


@dataclass(slots=True)
class FaceObservation:
    """A single detected face from one frame, before any tracker assignment."""

    bbox: np.ndarray              # shape (4,) float32 [x1, y1, x2, y2]
    det_score: float
    landmark_5: np.ndarray | None  # shape (5, 2)
    embedding: np.ndarray | None   # shape (512,) float32, L2-normed (None if not requested)
    yaw_deg: float | None
    pitch_deg: float | None
    age: float | None
    gender: int | None             # 0/1, when buffalo_l with gender head

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])

    @property
    def area(self) -> float:
        return self.width * self.height


class FaceRuntime:
    """Threadsafe wrapper around insightface FaceAnalysis.

    insightface's underlying ONNX Runtime sessions are threadsafe for inference,
    but `FaceAnalysis.get()` reuses internal state we don't fully control, so
    we serialize calls per-instance with a Lock. For higher throughput, run
    multiple FaceRuntime instances behind a process pool, or move to TensorRT
    in Phase 2."""

    _instance: "FaceRuntime | None" = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        *,
        name: str | None = None,
        ctx_id: int | None = None,
        det_size: int | None = None,
        providers: list[str] | None = None,
        run_recognition: bool | None = None,
    ) -> None:
        from insightface.app import FaceAnalysis  # imported lazily so docs/tests don't need it

        self._name = name or settings.insightface_model
        self._ctx_id = ctx_id if ctx_id is not None else settings.insightface_ctx_id
        self._det_size = det_size or settings.insightface_det_size
        self._providers = providers or settings.providers_list
        self._allowed_modules: list[str] | None = None

        # Remember the originally-requested CUDA configuration so a degraded
        # runtime can attempt to recover later. If the operator explicitly asked
        # for CPU (CUDAExecutionProvider not in the list), we never re-promote.
        self._original_providers = list(self._providers)
        self._original_ctx_id = self._ctx_id
        self._cuda_was_requested = "CUDAExecutionProvider" in self._original_providers

        # Degradation state. `_cuda_disabled_until` is a wall-clock deadline
        # in seconds; while non-zero we serve from CPU and only retry CUDA
        # after the deadline lapses.
        self._using_cpu_fallback = False
        self._cuda_disabled_until: float = 0.0

        # Skip the buffalo_l recognition module when an external recognizer
        # (e.g. AdaFace) will re-embed downstream — saves ~1ms/face on GPU.
        if run_recognition is None:
            run_recognition = settings.recognizer_backend.strip().lower() in (
                "insightface", "insightface_arc", "arcface", "buffalo",
            )
        self._run_recognition = run_recognition

        # `allowed_modules` filters which insightface model heads load. The
        # auxiliary landmark heads (2d106 / 1k3d68) are never read on the hot
        # path — the 5-point landmarks the recognizer needs come from SCRFD's
        # own `kps` output. Setting INSIGHTFACE_LOAD_AUX_LANDMARKS=true brings
        # them back if a downstream feature needs them.
        #
        # genderage: when INSIGHTFACE_ONDEMAND_GENDERAGE=true (default) the
        # head is NOT run inside FaceAnalysis.get() — the orchestrator calls
        # infra/genderage.py explicitly, only while a track's attribute vote
        # still needs samples. That turns genderage cost from
        # O(faces x frames) into <= attributes_max_votes calls per track, and
        # is the only way gender works under PIPELINE_BATCHED_INFERENCE=true.
        load_aux = bool(settings.insightface_load_aux_landmarks)
        inline_genderage = not bool(settings.insightface_ondemand_genderage)
        if run_recognition and load_aux and inline_genderage:
            allowed = None  # all default modules
        else:
            allowed = ["detection"]
            if run_recognition:
                allowed.append("recognition")
            if load_aux:
                allowed += ["landmark_2d_106", "landmark_3d_68"]
            if inline_genderage:
                allowed.append("genderage")
        self._allowed_modules = allowed

        log.info(
            "initializing insightface",
            model=self._name,
            ctx_id=self._ctx_id,
            det_size=self._det_size,
            providers=self._providers,
            run_recognition=run_recognition,
        )
        try:
            self._app = self._build_app(self._providers, self._ctx_id)
        except Exception as e:
            raise InferenceError(f"failed to load insightface model {self._name}: {e}") from e

        self._call_lock = threading.Lock()
        self._serialize = bool(settings.insightface_serialize_calls)
        # Guards the CUDA degrade / re-promote rebuilds only (see _guard).
        self._rebuild_lock = threading.Lock()
        self._warm_up()
        # Publish initial state so dashboards have a value before the first detect.
        RUNTIME_DEGRADED.labels(det_size=str(self._det_size)).set(0)
        # The pose probe runs once: the first time detect() returns at least
        # one face, we check whether the detector populated yaw/pitch. The
        # FaceQualityGate's pose filter is silently inert when this is False.
        self._pose_probe_done = False

        # Batched-detect state. The BatchedSCRFD wrapper and the AsyncBatcher
        # are lazy: built on the first detect_async() call when batched
        # inference is enabled. _batched_unavailable=True means we tried and
        # the underlying detector wasn't SCRFD or insightface internals
        # changed — never try again, just delegate to the per-image path.
        # BatchedSCRFD type left untyped here to keep the import deferred;
        # _ensure_batched_detector() imports it on first use.
        self._batched_scrfd = None  # type: BatchedSCRFD | None  # noqa: F821
        self._detect_batcher: AsyncBatcher | None = None
        self._batched_unavailable: bool = False
        self._batched_lock = threading.Lock()

    def _build_app(self, providers: list[str], ctx_id: int):
        from insightface.app import FaceAnalysis

        # Thread budget, TensorRT/CUDA order and the engine cache for the
        # sessions insightface is about to build (infra/ort_session.py).
        from vms_face.infra.ort_session import (
            configure_process_threads,
            install_insightface_session_policy,
            set_detector_input,
            set_model_filter,
        )
        configure_process_threads()
        install_insightface_session_policy()
        # Stop insightface from building (and, under TensorRT, engine-building)
        # sessions for heads it is about to discard.
        set_model_filter(self._allowed_modules)
        # Hand the loader the static export for THIS runtime's input size —
        # the only SCRFD graph TensorRT accepts (ort_session.ensure_static_detector).
        set_detector_input(self._det_input())

        app = FaceAnalysis(
            name=self._name,
            providers=providers,
            allowed_modules=self._allowed_modules,
        )
        app.prepare(
            ctx_id=ctx_id,
            det_size=self._det_input(),
            det_thresh=settings.insightface_det_threshold,
        )
        return app

    def _det_input(self) -> tuple[int, int]:
        """Detector input tensor, shaped to the camera's aspect ratio.

        A square input wastes most of its area on CCTV. Letterboxing 1920x1080
        into 960x960 leaves 43.8% of the tensor as black padding, and the model
        convolves those zeros on every frame at full cost.

        Worse, the padding is what limits RANGE. The scale factor is set by the
        tighter dimension, so a 960 square only scales the source by 0.5 — a
        100px face reaches the detector as 50px. Spending the same compute on a
        tensor shaped like the picture buys resolution instead of black bars:
        1280x736 has essentially the same pixel count as 960x960 (1.02x) but
        scales by 0.667, so faces arrive 33% larger and detect correspondingly
        further away.

        Height is derived from `insightface_det_aspect` (width : height) and
        rounded up to a multiple of 32, because SCRFD's anchors are
        stride-aligned and other sizes are silently re-padded — which would
        reintroduce the waste this exists to remove.

        An aspect of 0 keeps the square input, preserving previous behaviour.
        """
        aspect = float(getattr(settings, "insightface_det_aspect", 0) or 0)
        if aspect <= 0:
            return (self._det_size, self._det_size)
        height = max(160, int((int(self._det_size / aspect) + 31) // 32) * 32)
        return (self._det_size, height)

    @contextlib.contextmanager
    def _guard(self, *, exclusive: bool = False):
        """Serialize a call only when something needs exclusivity.

        detect() used to hold one lock per runtime for every call, which is
        why replicas existed: on an 18-camera deployment ~95% of detect
        latency was lock wait. ORT `InferenceSession.run()` is thread-safe and
        the detection-only FaceAnalysis has no shared mutable state on the
        detect path, so by default N cameras are inside ONE model copy at
        once. `exclusive=True` (a per-call det_thresh override, which mutates
        the shared detector) and the `insightface_serialize_calls` escape
        hatch restore the lock.
        """
        if exclusive or self._serialize:
            with self._call_lock:
                yield
        else:
            yield

    def _warm_up(self) -> None:
        """One inference at the live input shape, at construction.

        With the TensorRT provider the first call at a new shape BUILDS the
        engine — minutes on a cold cache, seconds on a warm one. Paying that
        here means it never lands on a camera's first frame. Also logs which
        provider actually runs the detector: ORT advertises TensorRT even
        when it silently fell back to CUDA.
        """
        w, h = self._det_input()
        t0 = time.perf_counter()
        try:
            self._app.get(np.zeros((h, w, 3), dtype=np.uint8), max_num=1)
        except Exception as e:  # warm-up must never take the runtime down
            log.warning("detector warm-up failed", err=str(e), det_input=(w, h))
            return
        det = getattr(self._app, "det_model", None)
        sess = getattr(det, "session", None)
        provider = sess.get_providers()[0] if sess is not None else "?"
        log.info(
            "detector ready",
            provider=provider,
            det_input=(w, h),
            warm_up_ms=round((time.perf_counter() - t0) * 1000, 1),
            serialize_calls=self._serialize,
        )

    def _degrade_to_cpu(self, reason: BaseException) -> None:
        # Lock-free callers can hit the same CUDA error at the same moment;
        # only the first rebuilds, the rest reuse its app.
        with self._rebuild_lock:
            if self._using_cpu_fallback and time.monotonic() < self._cuda_disabled_until:
                return
            self._degrade_to_cpu_locked(reason)

    def _degrade_to_cpu_locked(self, reason: BaseException) -> None:
        """Move this runtime onto the CPU execution provider after a CUDA
        failure, and arm a deadline at which we'll retry CUDA. The caller is
        expected to retry the original call against the now-CPU app."""
        retry_in = max(0.0, float(settings.insightface_cuda_retry_sec))
        self._cuda_disabled_until = time.monotonic() + retry_in if retry_in > 0 else float("inf")
        already_degraded = self._using_cpu_fallback
        self._app = self._build_app(["CPUExecutionProvider"], -1)
        self._providers = ["CPUExecutionProvider"]
        self._ctx_id = -1
        self._using_cpu_fallback = True
        RUNTIME_DEGRADED.labels(det_size=str(self._det_size)).set(1)
        RUNTIME_CUDA_FAILURES.labels(det_size=str(self._det_size), stage="detect").inc()
        if not already_degraded:
            log.warning(
                "insightface CUDA failed; serving from CPU temporarily",
                err=str(reason),
                retry_in_sec=retry_in,
            )

    def _maybe_repromote_cuda(self) -> None:
        # Cheap early-outs without the lock (this runs on every detect).
        if not self._using_cpu_fallback or not self._cuda_was_requested:
            return
        if time.monotonic() < self._cuda_disabled_until:
            return
        with self._rebuild_lock:
            self._maybe_repromote_cuda_locked()

    def _maybe_repromote_cuda_locked(self) -> None:
        """If we're on CPU and the cooldown has elapsed, try to rebuild on
        the originally-requested CUDA providers. On rebuild failure we extend
        the cooldown — never attempt CUDA twice in close succession."""
        if not self._using_cpu_fallback or not self._cuda_was_requested:
            return
        now = time.monotonic()
        if now < self._cuda_disabled_until:
            return
        try:
            new_app = self._build_app(self._original_providers, self._original_ctx_id)
        except Exception as e:
            self._cuda_disabled_until = now + max(1.0, float(settings.insightface_cuda_retry_sec))
            RUNTIME_CUDA_FAILURES.labels(det_size=str(self._det_size), stage="rebuild").inc()
            log.warning(
                "insightface CUDA re-promotion failed; staying on CPU",
                err=str(e),
                next_retry_in_sec=settings.insightface_cuda_retry_sec,
            )
            return
        self._app = new_app
        self._providers = list(self._original_providers)
        self._ctx_id = self._original_ctx_id
        self._using_cpu_fallback = False
        self._cuda_disabled_until = 0.0
        RUNTIME_DEGRADED.labels(det_size=str(self._det_size)).set(0)
        RUNTIME_CUDA_RECOVERED.labels(det_size=str(self._det_size)).inc()
        log.info("insightface re-promoted to CUDA", providers=self._providers)

    @property
    def runs_recognition(self) -> bool:
        return self._run_recognition

    @property
    def degraded(self) -> bool:
        """True when this runtime is currently serving from CPU after a
        CUDA failure. Cleared by a successful re-promotion."""
        return self._using_cpu_fallback

    def _record_pose_capability(self, observations: list[FaceObservation]) -> None:
        """One-shot probe: did the detector populate yaw/pitch? Many builds of
        buffalo_l ship without the pose head, in which case
        FaceQualityGate.evaluate's pose filter is silently inert. Operators
        should know this so they can swap to a head-pose model or accept the
        gap. Probed at the first non-empty detect() result."""
        self._pose_probe_done = True
        has_pose = any(obs.yaw_deg is not None and obs.pitch_deg is not None for obs in observations)
        DETECTOR_POSE_AVAILABLE.labels(det_size=str(self._det_size)).set(1 if has_pose else 0)
        if has_pose:
            log.info("detector pose head available", model=self._name, det_size=self._det_size)
        else:
            log.warning(
                "detector does NOT populate yaw/pitch; FaceQualityGate pose filter "
                "is inert. Swap to a head-pose model or accept that off-axis faces "
                "are not filtered upstream.",
                model=self._name,
                det_size=self._det_size,
            )

    # ── batched detect (PR #14 follow-up) ──────────────────────────────────

    def _ensure_batched_detector(self) -> AsyncBatcher | None:
        """First-touch lazy init for the batched SCRFD path. Returns the
        AsyncBatcher when available; returns None and latches off on any
        construction failure so a second call doesn't keep paying the cost."""
        if self._batched_unavailable:
            return None
        if self._detect_batcher is not None:
            return self._detect_batcher
        with self._batched_lock:
            if self._batched_unavailable:
                return None
            if self._detect_batcher is not None:
                return self._detect_batcher
            # Deferred import — batched_scrfd imports FaceObservation from
            # this module, so a top-level import here creates a cycle.
            from vms_face.infra.batched_scrfd import BatchedSCRFD
            try:
                self._batched_scrfd = BatchedSCRFD(self._app)
            except InferenceError as e:
                log.warning(
                    "batched detect unavailable; falling back to per-image",
                    det_size=self._det_size,
                    err=str(e),
                )
                self._batched_unavailable = True
                return None
            from vms_face.core.executors import get_gpu_pool

            self._detect_batcher = AsyncBatcher[np.ndarray, list[FaceObservation]](
                flush_fn=self._run_batched_detect,
                max_size=int(settings.batch_detect_max),
                window_sec=max(0.0, float(settings.batch_detect_window_ms) / 1000.0),
                stage="detect",
                # Dedicated inference pool, not asyncio's 32-thread default.
                executor=get_gpu_pool(),
            )
            log.info(
                "batched SCRFD detect enabled",
                det_size=self._det_size,
                max_batch=settings.batch_detect_max,
                window_ms=settings.batch_detect_window_ms,
            )
            return self._detect_batcher

    def _run_batched_detect(self, frames: list[np.ndarray]) -> list[list[FaceObservation]]:
        """Batcher flush callback. Holds the per-runtime lock so concurrent
        batches don't fight over the same ORT session. CUDA failures route
        through the same self-healing path as per-image detect()."""
        if not frames:
            return []
        with self._guard():
            self._maybe_repromote_cuda()
            try:
                # Type checker can't infer non-None across the lazy init, so
                # narrow defensively. The construction path guarantees this
                # is set when we reach here.
                assert self._batched_scrfd is not None
                results = self._batched_scrfd.detect_batch(frames)
            except Exception as e:
                if not _is_cuda_failure(e):
                    raise
                self._degrade_to_cpu(e)
                # After CPU degrade we have to rebuild the BatchedSCRFD
                # against the new app — the underlying ORT session changed.
                self._batched_scrfd = None
                self._detect_batcher = None
                self._batched_unavailable = False  # try again under CPU
                # Fall through to a per-image emergency call so the in-flight
                # frames don't all fail. They go through the slower path one
                # last time; subsequent frames re-init the batched path.
                results = [self.detect(f) for f in frames]
        if not self._pose_probe_done:
            for obs_list in results:
                if obs_list:
                    self._record_pose_capability(obs_list)
                    break
        return results

    async def detect_async(self, frame_bgr: np.ndarray) -> list[FaceObservation]:
        """Coalescing async detect. When pipeline_batched_inference is on AND
        the underlying detector is SCRFD, in-flight frames across cameras
        share a single ONNX call. Otherwise we delegate to the synchronous
        detect() in a thread (the orchestrator's existing run_in_executor
        wrapper still works — this method is the async-friendly seam)."""
        if frame_bgr is None or frame_bgr.size == 0:
            return []
        # Both fallbacks dispatch on the dedicated GPU pool, NOT the default
        # executor. The orchestrator branches on pipeline_batched_inference and
        # only wraps the *synchronous* detect in get_gpu_pool() — so a
        # `run_in_executor(None, ...)` here silently moves detect onto asyncio's
        # default pool (min(32, cpu+4) threads) the moment the flag is on.
        #
        # That pool is far too wide for inference: the GPU serializes the work
        # anyway, so 32 host threads just pile onto FaceRuntime._call_lock and
        # burn GIL — which is exactly why core/executors.py sizes gpu_pool at 4.
        import asyncio as _asyncio

        from vms_face.core.executors import get_gpu_pool

        loop = _asyncio.get_running_loop()
        if not settings.pipeline_batched_inference:
            return await loop.run_in_executor(get_gpu_pool(), self.detect, frame_bgr)
        batcher = self._ensure_batched_detector()
        if batcher is None:
            return await loop.run_in_executor(get_gpu_pool(), self.detect, frame_bgr)
        return await batcher.submit(frame_bgr)

    @classmethod
    def shared(cls) -> "FaceRuntime":
        """Default-size runtime (settings.insightface_det_size) for callers
        that don't care about per-camera detection input size — the API
        routes, enrollment, the known-faces bootstrap.

        Delegates to FaceRuntimePool so those callers share the pipeline's
        session instead of owning a second copy of the detector: before this
        the process held two identical default-size runtimes (two ORT
        sessions, two TensorRT engines) — one here, one in the pool.
        """
        return FaceRuntimePool.get(settings.insightface_det_size)

    @property
    def det_size(self) -> int:
        return self._det_size

    def detect(
        self, frame_bgr: np.ndarray, *, max_faces: int = 0, det_thresh: float | None = None
    ) -> list[FaceObservation]:
        """Detect + embed faces in a single BGR frame.

        Returns observations with embeddings populated (insightface always
        runs the recognition head when present in buffalo_l).

        `det_thresh` temporarily overrides the detector's confidence floor for
        THIS call only (restored in `finally`, under the same lock the live
        pipeline uses — so it never leaks). The forensic query-face path passes
        a permissive value: an uploaded photo is a deliberate single-face image,
        so a slightly-off-frontal / bearded / phone-compressed face that scores
        under the strict live-CCTV threshold should still be found."""
        if frame_bgr is None or frame_bgr.size == 0:
            return []

        # Lock-free unless a det_thresh override needs exclusivity (see
        # _guard). A concurrent normal call may observe the permissive
        # threshold for one frame; the quality gate's det-score floor absorbs
        # the few extra low-score boxes that produces.
        with self._guard(exclusive=det_thresh is not None):
            # Opportunistically re-promote to CUDA when the cooldown has lapsed.
            # Cheap when we're already on CUDA (early return).
            self._maybe_repromote_cuda()
            det_model = getattr(self._app, "det_model", None)
            prev_thresh = None
            if det_thresh is not None and det_model is not None:
                prev_thresh = getattr(det_model, "det_thresh", None)
                if prev_thresh is not None:
                    det_model.det_thresh = float(det_thresh)
            try:
                faces: list[Any] = self._app.get(frame_bgr, max_num=max_faces)
            except Exception as e:
                # Only catch what looks like a CUDA-EP failure. Genuine bugs
                # (bad input shape, broken model file) must propagate so they
                # surface in metrics + logs and don't get masked by a silent
                # CPU degrade-and-retry loop.
                if not _is_cuda_failure(e):
                    raise
                self._degrade_to_cpu(e)
                faces = self._app.get(frame_bgr, max_num=max_faces)
            finally:
                # Restore the strict threshold so the shared runtime is unchanged
                # for the live pipeline's next call.
                if prev_thresh is not None and det_model is not None:
                    det_model.det_thresh = prev_thresh

        out: list[FaceObservation] = []
        for f in faces:
            yaw, pitch = _pose_from_face(f)
            out.append(
                FaceObservation(
                    bbox=np.asarray(f.bbox, dtype=np.float32),
                    det_score=float(getattr(f, "det_score", 0.0) or 0.0),
                    landmark_5=np.asarray(f.kps, dtype=np.float32) if getattr(f, "kps", None) is not None else None,
                    embedding=_normed_embedding(f),
                    yaw_deg=yaw,
                    pitch_deg=pitch,
                    age=float(getattr(f, "age", 0.0)) if getattr(f, "age", None) is not None else None,
                    gender=int(f.gender) if getattr(f, "gender", None) is not None else None,
                )
            )
        if not self._pose_probe_done and out:
            self._record_pose_capability(out)
        return out


class FaceRuntimePool:
    """Pool of FaceRuntime instances keyed by detection input size.

    A 4K parking-lot camera and a 720p doorway camera should not share the
    same SCRFD input resolution — small faces in the parking lot need 1024
    or 1280 to be detectable, while the doorway camera saves GPU at 480.
    The Camera schema already has `detection_input_size`; this pool is what
    actually honors it.

    Each runtime used to serialize its detect() calls on a Lock; since
    2026-09-20 that lock is off by default (FaceRuntime._guard) because ORT
    sessions are thread-safe, so one runtime serves every camera and replicas
    only add CUDA streams.

    That lock used to be the pipeline's bottleneck. The pool held exactly one
    runtime per det_size, and since every camera is normally configured with
    the same det_size, every camera in the process queued behind one lock. On
    an 18-camera deployment the measured effect was stark: ~95% of detect
    latency was lock wait, throughput capped at roughly one detect per service
    time, and the GPU sat mostly idle because nothing could dispatch to it in
    parallel.

    So the pool now holds N REPLICAS per size and hands them out round-robin.
    N cameras can be inside the model at once, which is what actually uses the
    GPU. Cost is one model copy of VRAM per replica, so the count is
    configurable (`insightface_runtime_replicas`); set it to 1 for the old
    behaviour."""

    _pool: "dict[tuple[int, int], FaceRuntime]" = {}
    _rr: "dict[int, int]" = {}
    _lock = threading.Lock()

    @staticmethod
    def _bucket(det_size: int | None) -> int:
        size = int(det_size or settings.insightface_det_size)
        # Coerce to a sensible bucket so we don't end up with one runtime
        # per unique pixel count. Round up to the nearest 32 (SCRFD anchors
        # are stride-aligned; non-multiples-of-32 are silently re-padded).
        return max(160, ((size + 31) // 32) * 32)

    @classmethod
    def get(cls, det_size: int | None = None, *, local: bool = False) -> "FaceRuntime":
        size = cls._bucket(det_size)
        if settings.infer_remote and not local:
            # Phase 2: no models in this process — detect goes to the
            # inference service (infra/infer_client.py); one facade per size.
            with cls._lock:
                rt = cls._pool.get((size, -1))
                if rt is None:
                    from vms_face.infra.infer_client import RemoteFaceRuntime
                    rt = RemoteFaceRuntime(det_size=size)  # type: ignore[assignment]
                    cls._pool[(size, -1)] = rt  # type: ignore[assignment]
                    log.info("remote face runtime", det_size=size, service=settings.infer_service_url)
                return rt  # type: ignore[return-value]
        replicas = max(1, int(getattr(settings, "insightface_runtime_replicas", 1)))

        with cls._lock:
            # Round-robin so concurrent cameras spread across replicas instead
            # of piling onto whichever one they happened to ask for first.
            idx = cls._rr.get(size, 0) % replicas
            cls._rr[size] = idx + 1
            rt = cls._pool.get((size, idx))
            if rt is not None:
                return rt
            # Built lazily: a deployment watching 2 cameras should not pay for
            # replicas it will never dispatch to.
            log.info("creating face runtime", det_size=size, replica=idx, replicas=replicas)
            rt = FaceRuntime(det_size=size)
            cls._pool[(size, idx)] = rt
            return rt

    @classmethod
    def all(cls) -> list["FaceRuntime"]:
        return list(cls._pool.values())


def _normed_embedding(face: Any) -> np.ndarray | None:
    emb = getattr(face, "normed_embedding", None)
    if emb is None:
        emb = getattr(face, "embedding", None)
        if emb is None:
            return None
        emb = np.asarray(emb, dtype=np.float32)
        n = float(np.linalg.norm(emb))
        if n > 0:
            emb = emb / n
        return emb
    return np.asarray(emb, dtype=np.float32)


def _pose_from_face(face: Any) -> tuple[float | None, float | None]:
    """insightface buffalo_l does not always populate `pose`. Return (yaw, pitch) in degrees if available."""
    pose = getattr(face, "pose", None)
    if pose is None:
        return None, None
    arr = np.asarray(pose, dtype=np.float32).flatten()
    # buffalo_l pose layout: [pitch, yaw, roll]
    if arr.size >= 2:
        return float(arr[1]), float(arr[0])
    return None, None
