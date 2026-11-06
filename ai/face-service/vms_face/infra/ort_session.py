"""ONNX Runtime session policy for the whole process.

Every ORT session in vms_face — the SCRFD detector that insightface builds
for us, the batched ArcFace recognizer, genderage, the YOLO person detector,
AdaFace — is created through here, so three decisions are made once:

1. Thread budget. ORT's default gives each session an intra-op pool sized to
   every core on the box, and those threads spin-wait between kernels.
   Measured on the live process (docs/FACE_SYSTEM_DESIGN.md §1.3): 480
   unnamed threads from the pools alone, 546 in total, for two cameras. A GPU
   session needs host threads only to launch kernels — two is plenty — and
   spinning is switched off so an idle session costs nothing.

2. Execution providers. TensorRT when its libraries can actually be loaded,
   then CUDA, then CPU. ORT *advertises* the TensorRT provider even when
   libnvinfer is absent and then silently falls back to CUDA (that is how the
   image ran FP32 on CUDA for months while "having" TensorRT), so the check
   here is "can we dlopen libnvinfer.so.10", never `get_available_providers()`.
   FP16 is on for TensorRT. Whether the *recognizer* may run FP16 is a separate
   switch, off until eval/recognizer_parity.py proves the vectors still match
   the enrolled gallery at cosine >= 0.9999.

3. Engine cache. TensorRT builds one engine per (model, input shape), which
   takes minutes on a cold cache. The cache directory lives on the insightface
   bind mount so engines survive container recreation; they are specific to a
   GPU SKU, so a different card rebuilds them once.

insightface constructs its own sessions inside model_zoo.
`install_insightface_session_policy()` wraps that constructor so those
sessions receive the same options without patching the library on disk.
"""
from __future__ import annotations

import contextlib
import ctypes
import importlib.util
import os
import threading
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

# Reentrant: tensorrt_loadable() is reached from inside other guarded
# sections (a plain Lock deadlocked the service at startup on 2026-09-20).
_lock = threading.RLock()
_trt_state: dict[str, Any] = {}          # {"loadable": bool, "lib_dir": str|None, "error": str|None}
_process_threads_configured = False

TRT_SONAMES = ("libnvinfer.so.10", "libnvonnxparser.so.10")


# ── TensorRT availability ────────────────────────────────────────────────────

def _tensorrt_lib_dirs() -> list[Path]:
    """Where libnvinfer may live: the NVIDIA pip wheel first (what the image
    installs), then the apt location."""
    dirs: list[Path] = []
    spec = importlib.util.find_spec("tensorrt_libs")
    if spec is not None and spec.submodule_search_locations:
        dirs.extend(Path(p) for p in spec.submodule_search_locations)
    dirs.append(Path("/usr/lib/x86_64-linux-gnu"))
    return dirs


def tensorrt_loadable() -> bool:
    """True when ORT's TensorRT provider will be able to resolve libnvinfer.

    Preloading the libraries with RTLD_GLOBAL is what makes this work without
    LD_LIBRARY_PATH: once a soname is already mapped into the process, the
    dynamic linker satisfies the provider's DT_NEEDED entries from it.
    """
    with _lock:
        if "loadable" in _trt_state:
            return bool(_trt_state["loadable"])
        if not settings.tensorrt_enabled:
            _trt_state.update(loadable=False, lib_dir=None, error="disabled by TENSORRT_ENABLED")
            return False
        last_err: str | None = None
        for d in _tensorrt_lib_dirs():
            try:
                for soname in TRT_SONAMES:
                    p = d / soname
                    ctypes.CDLL(str(p) if p.exists() else soname, mode=ctypes.RTLD_GLOBAL)
                _trt_state.update(loadable=True, lib_dir=str(d), error=None)
                log.info("tensorrt libraries loaded", lib_dir=str(d))
                return True
            except OSError as e:  # missing file / unresolved dependency
                last_err = str(e)
                continue
        _trt_state.update(loadable=False, lib_dir=None, error=last_err)
        log.warning(
            "tensorrt libraries not loadable; sessions will use CUDA",
            err=last_err,
            hint="pip install --extra-index-url https://pypi.nvidia.com tensorrt-cu12-libs",
        )
        return False


def describe() -> dict[str, Any]:
    """For /health and startup logs."""
    tensorrt_loadable()
    return {
        "tensorrt": bool(_trt_state.get("loadable")),
        "tensorrt_lib_dir": _trt_state.get("lib_dir"),
        "tensorrt_error": _trt_state.get("error"),
        "fp16": bool(settings.tensorrt_fp16),
        "fp16_recognizer": bool(settings.tensorrt_fp16_recognizer),
        "engine_cache": settings.tensorrt_cache_dir,
        "intra_op_threads": int(settings.ort_intra_op_threads),
        "onnxruntime": ort.__version__,
    }


# ── Session options ──────────────────────────────────────────────────────────

def session_options() -> ort.SessionOptions:
    """A fresh SessionOptions with the process-wide thread budget."""
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = max(1, int(settings.ort_intra_op_threads))
    so.inter_op_num_threads = max(1, int(settings.ort_inter_op_threads))
    # Idle pools must not spin: with one pool per session and several
    # sessions per process, spinning was the entire idle CPU bill.
    so.add_session_config_entry(
        "session.intra_op.allow_spinning", "1" if settings.ort_allow_spinning else "0"
    )
    return so


# ── Providers ────────────────────────────────────────────────────────────────

def _kind_for(model_path: str | Path, kind: str | None) -> str:
    if kind:
        return kind
    stem = Path(model_path).stem.lower()
    if any(k in stem for k in ("w600k", "glintr", "arcface", "adaface", "ir101", "_r50", "_r100", "mbf")):
        return "recognizer"
    if "genderage" in stem:
        return "genderage"
    if stem.startswith("det_") or "scrfd" in stem:
        return "detector"
    return "generic"


def _trt_options(model_path: str | Path, kind: str) -> dict[str, str]:
    cache = Path(settings.tensorrt_cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    fp16 = bool(settings.tensorrt_fp16)
    if kind == "recognizer":
        fp16 = fp16 and bool(settings.tensorrt_fp16_recognizer)
    stem = Path(model_path).stem
    opts: dict[str, str] = {
        "device_id": str(max(0, int(settings.insightface_ctx_id))),
        # ORT's TensorRT option parser accepts only the literal strings
        # True/False for its booleans ("1" is rejected and the whole provider
        # silently drops to CUDA — that is exactly what happened on first try).
        "trt_fp16_enable": "True" if fp16 else "False",
        "trt_engine_cache_enable": "True",
        "trt_engine_cache_path": str(cache),
        # Distinct engines per precision, so flipping FP16 never reuses a
        # stale engine built the other way.
        "trt_engine_cache_prefix": f"{stem}_{'fp16' if fp16 else 'fp32'}",
        "trt_timing_cache_enable": "True",
        "trt_timing_cache_path": str(cache),
        "trt_max_workspace_size": str(int(settings.tensorrt_workspace_mb) * 1024 * 1024),
    }
    # Models with a dynamic batch axis get an explicit profile, otherwise the
    # provider rebuilds the engine every time a new batch size shows up. The
    # detector has a fixed batch of 1 and a constant HxW per runtime, so its
    # first-seen shape is the profile.
    if kind == "recognizer":
        name = settings.tensorrt_recognizer_input
        opt = max(1, int(settings.batch_embed_max))
        mx = max(opt, int(settings.tensorrt_recognizer_max_batch))
        opts["trt_profile_min_shapes"] = f"{name}:1x3x112x112"
        opts["trt_profile_opt_shapes"] = f"{name}:{opt}x3x112x112"
        opts["trt_profile_max_shapes"] = f"{name}:{mx}x3x112x112"
    elif kind == "detector" and "batchN" in stem and _detector_input:
        # Dynamic-batch static-HxW export: one engine covering 1..max frames
        # per call, optimised for the batch the cross-camera batcher usually
        # fills. Without a profile TensorRT would rebuild per batch size.
        w, h = _detector_input
        name = settings.tensorrt_detector_input
        mx = max(1, int(settings.batch_detect_max))
        opt = min(4, mx)
        opts["trt_profile_min_shapes"] = f"{name}:1x3x{h}x{w}"
        opts["trt_profile_opt_shapes"] = f"{name}:{opt}x3x{h}x{w}"
        opts["trt_profile_max_shapes"] = f"{name}:{mx}x3x{h}x{w}"
    elif kind == "detector_u8" and _detector_input:
        # ensure_u8_detector(): NHWC uint8 in, same dynamic batch as above.
        w, h = _detector_input
        mx = max(1, int(settings.batch_detect_max))
        opt = min(4, mx)
        opts["trt_profile_min_shapes"] = f"input_u8:1x{h}x{w}x3"
        opts["trt_profile_opt_shapes"] = f"input_u8:{opt}x{h}x{w}x3"
        opts["trt_profile_max_shapes"] = f"input_u8:{mx}x{h}x{w}x3"
    elif kind == "genderage":
        opts["trt_profile_min_shapes"] = "data:1x3x96x96"
        opts["trt_profile_opt_shapes"] = "data:8x3x96x96"
        opts["trt_profile_max_shapes"] = "data:16x3x96x96"
    return opts


def _cuda_options() -> dict[str, str]:
    return {
        "device_id": str(max(0, int(settings.insightface_ctx_id))),
        # Grow the arena by what was asked, not by doubling: several sessions
        # share one GPU and a doubling arena evicts its neighbours.
        "arena_extend_strategy": "kSameAsRequested",
    }


def providers_for(
    model_path: str | Path,
    *,
    requested: list[str] | None = None,
    kind: str | None = None,
) -> tuple[list[str], list[dict[str, str]]]:
    """Provider names and aligned option dicts for `InferenceSession`.

    `requested` is what the caller asked for (settings.providers_list by
    default). If it does not include CUDA — the CPU-degrade path — the answer
    is CPU only; TensorRT is never added behind the caller's back.
    """
    req = list(requested) if requested else list(settings.providers_list)
    if "CUDAExecutionProvider" not in req:
        return ["CPUExecutionProvider"], [{}]
    k = _kind_for(model_path, kind)
    names: list[str] = []
    opts: list[dict[str, str]] = []
    use_trt = tensorrt_loadable() and (k != "recognizer" or bool(settings.tensorrt_recognizer))
    if use_trt:
        names.append("TensorrtExecutionProvider")
        opts.append(_trt_options(model_path, k))
    names.append("CUDAExecutionProvider")
    opts.append(_cuda_options())
    names.append("CPUExecutionProvider")
    opts.append({})
    return names, opts


def active_provider(session: ort.InferenceSession) -> str:
    """The provider that will actually run the graph — the first in the
    session's resolved list, which is the only trustworthy signal."""
    try:
        return session.get_providers()[0]
    except Exception:
        return "?"


@contextlib.contextmanager
def _engine_build_lock(model_path: str | Path):
    """Session creation = CUDA context creation + (TensorRT) engine build or
    load. Both must be one-at-a-time across the box: concurrent context
    creation segfaults on this platform (infra/cuda_gate.py), and concurrent
    engine builds write the same cache and timing files. One gate for both."""
    from vms_face.infra.cuda_gate import cuda_init_gate
    with cuda_init_gate(f"ort session {Path(model_path).name}"):
        yield


def _warm_up_session(session: ort.InferenceSession) -> None:
    """One inference on minimal zero inputs. The TensorRT provider builds and
    writes its engine at the first Run(), not at construction — so the build
    has to happen here, inside the engine lock, or the next process reads a
    half-written engine file."""
    dtypes = {
        "tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(uint8)": np.uint8,
        "tensor(int64)": np.int64, "tensor(int32)": np.int32, "tensor(bool)": np.bool_,
    }
    feeds = {}
    for inp in session.get_inputs():
        shape = [d if isinstance(d, int) and d > 0 else 1 for d in inp.shape]
        feeds[inp.name] = np.zeros(shape, dtype=dtypes.get(inp.type, np.float32))
    session.run(None, feeds)


def make_session(
    model_path: str | Path,
    *,
    requested: list[str] | None = None,
    kind: str | None = None,
) -> ort.InferenceSession:
    names, opts = providers_for(model_path, requested=requested, kind=kind)
    with _engine_build_lock(model_path):
        session = ort.InferenceSession(
            str(model_path), sess_options=session_options(), providers=names, provider_options=opts
        )
        _warm_up_session(session)
    got = active_provider(session)
    if names[0] == "TensorrtExecutionProvider" and got != "TensorrtExecutionProvider":
        log.warning("tensorrt requested but session runs elsewhere", model=Path(model_path).name, provider=got)
    else:
        log.info("onnx session", model=Path(model_path).name, provider=got, kind=_kind_for(model_path, kind))
    return session


# ── insightface hook ─────────────────────────────────────────────────────────

# FaceAnalysis.__init__ calls model_zoo.get_model() on EVERY .onnx in the
# model pack and only afterwards drops the ones outside `allowed_modules`.
# Each of those calls builds an ORT session — with TensorRT, an engine build
# for the static-shape landmark heads — for a model that is deleted a line
# later. This filter answers None for excluded heads before any session
# exists; FaceAnalysis treats None as "model not recognized" and moves on.
_MODEL_TASK_BY_STEM = {
    "1k3d68": "landmark_3d_68",
    "2d106det": "landmark_2d_106",
    "genderage": "genderage",
}
_allowed_tasks: set[str] | None = None
_detector_input: tuple[int, int] | None = None   # (W, H) the runtime being built will use


def set_detector_input(size: tuple[int, int] | None) -> None:
    """Tell the loader hook which input size the detector about to be built
    will run at, so it can hand insightface the static export for it."""
    global _detector_input
    _detector_input = (int(size[0]), int(size[1])) if size else None


def ensure_static_detector(src: str | Path, width: int, height: int, batch: str | None = None) -> str:
    """The SCRFD export with its input pinned to 1x3xHxW and every shape op
    constant-folded — the only form TensorRT builds an engine from.

    TensorRT rejects the shipped dynamic-HxW `det_10g.onnx` ("Input dimensions
    with this name have different constant values or have contradictory
    IOptimizationProfile constraints"), with or without an explicit profile.
    Pinning the input and folding through ORT's BASIC optimizer (standard ONNX
    ops only — EXTENDED would insert ORT-specific fused ops the TensorRT parser
    cannot read) produced an engine that runs at 3.56 ms vs 5.63 ms on CUDA
    FP32 at 960x544, boxes identical to the dynamic model. Built once per
    (model, size) into the engine-cache directory; a few seconds of CPU.
    """
    src = Path(src)
    cache = Path(settings.tensorrt_cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    tag = f"batch{batch}_" if batch else ""
    dst = cache / f"{src.stem}_{width}x{height}_{tag}static.onnx"
    with _lock:
        if dst.exists() and dst.stat().st_size > 0:
            return str(dst)
        import onnx  # insightface dependency; imported lazily

        model = onnx.load(str(src))
        dims = model.graph.input[0].type.tensor_type.shape.dim
        if len(dims) != 4:
            raise RuntimeError(f"{src.name}: expected a 4-D input, got {len(dims)} dims")
        # The shipped export names BOTH spatial dims with the same symbol ('?'),
        # and TensorRT requires same-named dims to be equal — that is the whole
        # "contradictory constraints" error. dim_value/dim_param are a protobuf
        # oneof: assigning dim_value alone pins the dim and drops the name.
        # (Assigning dim_param="" afterwards would un-pin it to None, which
        # insightface then reads as an input size of (None, None).)
        for i, v in ((2, height), (3, width)):
            dims[i].dim_value = v
        if batch:
            # A named symbolic batch axis. The graph itself is batch-clean —
            # every Reshape is [-1, C] and a batch of two runs on CPU — but
            # the export also carries INTERMEDIATE value_info with batch 1
            # baked in ({1,56,34,60}), and ORT's buffer planner trusts it:
            # "Shape mismatch attempting to re-use buffer {1,...} != {2,...}".
            # Dropping value_info makes ORT re-infer with the symbolic batch.
            dims[0].dim_param = batch
        else:
            dims[0].dim_value = 1
        del model.graph.value_info[:]
        # Output value_info carries the 640x640 export-time shapes; at any
        # other size they are simply wrong, so let shape inference own them.
        for out in model.graph.output:
            out.type.tensor_type.ClearField("shape")
        pinned = cache / f"{src.stem}_{width}x{height}_pinned.onnx"
        onnx.save(model, str(pinned))
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.optimized_model_filepath = str(dst)
        so.log_severity_level = 3
        ort.InferenceSession(str(pinned), so, providers=["CPUExecutionProvider"])
        pinned.unlink(missing_ok=True)
        got = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"]).get_inputs()[0].shape
        want = [batch or 1, 3, height, width]
        if list(got) != want:
            dst.unlink(missing_ok=True)
            raise RuntimeError(f"static export came back with input shape {got}, expected {want}")
        log.info("static detector export built", model=dst.name, input=(width, height), batch=batch or 1)
        return str(dst)


def ensure_u8_detector(static_src: str | Path, *, mean: float, std: float) -> str:
    """The batched static export with SCRFD's preprocessing folded into the
    graph. New input `input_u8` [N,H,W,3] uint8 — the BGR letterboxed canvas
    exactly as cv2 hands it over — then Cast -> NHWC->NCHW -> BGR->RGB ->
    (x - mean) / std feeds the original `input.1`. What cv2.dnn.blobFromImage
    did per frame on a CPU thread now runs on the GPU, and the host->device
    copy is uint8 instead of float32 (4x smaller). Built once next to the
    static export."""
    import numpy as np

    src = Path(static_src)
    dst = src.with_name(src.stem + "_u8.onnx")
    with _lock:
        if dst.exists() and dst.stat().st_size > 0:
            return str(dst)
        import onnx
        from onnx import TensorProto, helper, numpy_helper

        model = onnx.load(str(src))
        g = model.graph
        if len(g.input) != 1:
            raise RuntimeError(f"{src.name}: expected one graph input, got {len(g.input)}")
        inp = g.input[0]
        name = inp.name
        dims = [d.dim_param or d.dim_value for d in inp.type.tensor_type.shape.dim]
        if len(dims) != 4 or dims[1] != 3:
            raise RuntimeError(f"{src.name}: expected an Nx3xHxW input, got {dims}")
        n, _, h, w = dims
        u8 = helper.make_tensor_value_info("input_u8", TensorProto.UINT8, [n, h, w, 3])
        g.initializer.extend([
            numpy_helper.from_array(np.full((1, 1, 1, 1), float(mean), dtype=np.float32), "pre_mean"),
            numpy_helper.from_array(np.full((1, 1, 1, 1), 1.0 / float(std), dtype=np.float32), "pre_inv_std"),
        ])
        pre = [
            helper.make_node("Cast", ["input_u8"], ["pre_f32"], to=TensorProto.FLOAT, name="pre_cast"),
            helper.make_node("Transpose", ["pre_f32"], ["pre_nchw"], perm=[0, 3, 1, 2], name="pre_nchw"),
            # opset 11: `split` is an attribute (it became an input in 13).
            helper.make_node("Split", ["pre_nchw"], ["pre_b", "pre_g", "pre_r"], axis=1, split=[1, 1, 1], name="pre_split"),
            helper.make_node("Concat", ["pre_r", "pre_g", "pre_b"], ["pre_rgb"], axis=1, name="pre_rgb"),
            helper.make_node("Sub", ["pre_rgb", "pre_mean"], ["pre_centered"], name="pre_sub"),
            helper.make_node("Mul", ["pre_centered", "pre_inv_std"], [name], name="pre_scale"),
        ]
        body = list(g.node)
        del g.node[:]
        g.node.extend(pre + body)
        del g.input[:]
        g.input.extend([u8])
        onnx.save(model, str(dst))
        sess = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"])
        got = sess.get_inputs()[0]
        if got.name != "input_u8" or got.type != "tensor(uint8)":
            dst.unlink(missing_ok=True)
            raise RuntimeError(f"uint8 export came back as {got.name}:{got.type}")
        log.info("uint8 detector export built", model=dst.name, input=(w, h), mean=mean, std=std)
        return str(dst)


def set_model_filter(allowed_modules: list[str] | None) -> None:
    """Tasks insightface may load; None = everything (its default)."""
    global _allowed_tasks
    _allowed_tasks = set(allowed_modules) if allowed_modules is not None else None


def _task_for_stem(stem: str) -> str | None:
    s = stem.lower()
    if s in _MODEL_TASK_BY_STEM:
        return _MODEL_TASK_BY_STEM[s]
    if s.startswith("det_") or "scrfd" in s:
        return "detection"
    if any(k in s for k in ("w600k", "glintr", "arcface")):
        return "recognition"
    return None


def install_insightface_session_policy() -> None:
    """Make every session insightface builds go through this policy.

    model_zoo.ModelRouter.get_model() constructs `PickableInferenceSession`
    with bare provider names and no SessionOptions — that is where the
    all-cores spinning pools came from. Replacing the class in the module
    namespace is enough: the constructor is looked up by name at call time.
    Idempotent.
    """
    info = describe()  # loads the TensorRT libraries; takes the lock on its own
    with _lock:
        try:
            from insightface.model_zoo import model_zoo as mz
        except Exception as e:  # insightface not installed (docs / tooling)
            log.debug("insightface not importable; session policy not installed", err=str(e))
            return
        if getattr(mz, "_vms_session_policy", False):
            return
        base = mz.PickableInferenceSession

        class PolicySession(base):  # type: ignore[misc,valid-type]
            def __init__(self, model_path, **kwargs):
                kwargs.setdefault("sess_options", session_options())
                provs = kwargs.get("providers")
                if provs and all(isinstance(p, str) for p in provs) and not kwargs.get("provider_options"):
                    names, opts = providers_for(model_path, requested=list(provs))
                    kwargs["providers"] = names
                    kwargs["provider_options"] = opts
                with _engine_build_lock(model_path):
                    super().__init__(model_path, **kwargs)
                    _warm_up_session(self)
                log.info(
                    "onnx session (insightface)",
                    model=Path(str(model_path)).name,
                    provider=active_provider(self),
                )

        PolicySession.__name__ = base.__name__
        PolicySession.__qualname__ = base.__qualname__
        mz.PickableInferenceSession = PolicySession

        orig_get_model = mz.get_model

        def get_model(name, **kwargs):
            task = _task_for_stem(Path(str(name)).stem)
            if _allowed_tasks is not None and task is not None and task not in _allowed_tasks:
                log.info("model skipped before load", model=Path(str(name)).name, task=task)
                return None
            if task == "detection" and _detector_input and settings.detector_static_export:
                try:
                    # A free batch axis when cross-camera batching is on, so
                    # BatchedSCRFD can stack frames (its check needs a
                    # non-1 batch dim); the per-image path still runs batch 1.
                    batch = "N" if settings.pipeline_batched_inference else None
                    name = ensure_static_detector(name, *_detector_input, batch=batch)
                except Exception as e:  # fall back to the shipped export (CUDA)
                    log.warning("static detector export failed; using dynamic model", err=str(e))
            return orig_get_model(name, **kwargs)

        mz.get_model = get_model
        mz._vms_session_policy = True
        log.info("insightface session policy installed", **info)


# ── Process-wide thread hygiene ──────────────────────────────────────────────

def configure_process_threads() -> None:
    """OpenCV's pool and BLAS threads, once per process. OMP/OpenBLAS have to
    be set in the environment before NumPy loads (compose does that); this
    covers what can still be changed at runtime."""
    global _process_threads_configured
    with _lock:
        if _process_threads_configured:
            return
        _process_threads_configured = True
    try:
        import cv2
        cv2.setNumThreads(max(0, int(settings.opencv_threads)))
    except Exception as e:
        log.debug("cv2.setNumThreads unavailable", err=str(e))
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")
