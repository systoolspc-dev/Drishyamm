from __future__ import annotations

import threading

from vms_face.config import settings
from vms_face.core.exceptions import ConfigurationError
from vms_face.core.logging import get_logger
from vms_face.infra.recognizers.base import Recognizer

log = get_logger(__name__)

_lock = threading.Lock()
_instance: Recognizer | None = None


def build_recognizer(backend: str | None = None) -> Recognizer:
    name = (backend or settings.recognizer_backend).strip().lower()
    if settings.infer_remote and name in ("insightface_batched", "arcface_batched", "insightface", "insightface_arc", "arcface", "buffalo"):
        # Phase 2: vectors come from the inference service's recognizer (the
        # same weights, so the gallery space is unchanged); this process
        # loads no recognizer model.
        from vms_face.infra.recognizers.infer_client_rec import InferClientRecognizer
        return InferClientRecognizer()
    if name in ("insightface", "insightface_arc", "arcface", "buffalo"):
        from vms_face.infra.recognizers.insightface_arc import InsightFaceArcRecognizer
        return InsightFaceArcRecognizer()
    if name in ("insightface_batched", "arcface_batched"):
        # Same weights and the same vectors as "insightface", but embedded
        # standalone so the orchestrator's quality / embed_every_n / pool gates
        # actually skip forward passes, and so crops batch across cameras.
        # Keep this name OUT of the run-recognition list in
        # FaceRuntime.__init__ — that absence is what stops the detector
        # loading the recognition head.
        from vms_face.infra.recognizers.batched_arcface import BatchedArcFaceRecognizer
        return BatchedArcFaceRecognizer(providers=settings.providers_list)
    if name == "remote":
        # Edge shape: no recognizer model here at all. Aligned crops go to the
        # server's /edge/embed and come back in the server's embedding space.
        # Also absent from FaceRuntime's run-recognition list → detection-only.
        from vms_face.infra.recognizers.remote import RemoteRecognizer
        return RemoteRecognizer()
    if name == "adaface":
        if not settings.adaface_model_path:
            raise ConfigurationError(
                "RECOGNIZER_BACKEND=adaface requires ADAFACE_MODEL_PATH in .env"
            )
        from vms_face.infra.recognizers.adaface import AdaFaceONNXRecognizer
        providers = settings.providers_list  # reuse insightface's provider list
        return AdaFaceONNXRecognizer(settings.adaface_model_path, providers=providers)
    raise ConfigurationError(f"unknown recognizer backend: {backend!r}")


def get_recognizer() -> Recognizer:
    """Process-wide singleton. Configured by `settings.recognizer_backend`."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = build_recognizer()
                log.info("recognizer initialized", backend=_instance.name)
    return _instance


def reset_recognizer() -> None:
    """For tests / runtime swaps."""
    global _instance
    with _lock:
        _instance = None
