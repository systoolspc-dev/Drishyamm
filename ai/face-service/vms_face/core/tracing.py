"""OpenTelemetry plumbing.

Goals:
  1. Zero overhead when disabled. The OTel SDK + instrumentations are imported
     lazily; with VMS_OTEL_ENABLED=false this module is a near no-op.
  2. Single trace_id follows a face from orchestrator → Redis Stream →
     match-worker → Postgres/Qdrant. Implemented by stuffing W3C
     traceparent into the FaceCandidate.extra._trace dict on publish and
     resolving it back to a Context on consume.
  3. Logs and spans correlate. We bind trace_id/span_id into structlog so a
     log line for a particular face can be searched both ways.

Component boundary:
  - `init_tracing(component)` is called once at process startup. Idempotent.
    Safe to call again with a different component name (no-op).
  - `traced(name, **attrs)` is the manual span helper for the hot path.
  - `inject_context(carrier_dict)` / `extract_context(carrier_dict)` are the
    only cross-process bits — the Redis bus calls them.
"""
from __future__ import annotations

import contextlib
import logging
from typing import Any, Iterator

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

# Module-level singletons. Imports happen inside init_tracing() so the
# OTel packages aren't required when VMS_OTEL_ENABLED=false.
_TRACER = None             # opentelemetry.trace.Tracer | None
_PROPAGATOR = None         # TraceContextTextMapPropagator | None
_INITIALIZED: str | None = None
_NOOP_CM = contextlib.nullcontext()


# ────────────────────────────────────────────────────────────────────────────
# Initialization
# ────────────────────────────────────────────────────────────────────────────


def init_tracing(component: str) -> None:
    """Configure the global tracer + auto-instrumentations for the given
    component (api, match-worker, reid-worker, retention, orchestrator).
    Idempotent: subsequent calls are no-ops."""
    global _TRACER, _PROPAGATOR, _INITIALIZED
    if _INITIALIZED is not None:
        return
    if not settings.vms_otel_enabled:
        _INITIALIZED = "disabled"
        return

    # Real imports only when actually enabling. Failures here mean the OTel
    # packages aren't installed; we log loudly and stay disabled rather than
    # crashing the service.
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.propagators.tracecontext import TraceContextTextMapPropagator
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import TraceIdRatioBased
    except ImportError as e:
        log.warning("OTel packages missing; tracing stays disabled", err=str(e))
        _INITIALIZED = "missing-deps"
        return

    resource = Resource.create({
        "service.name": settings.vms_otel_service_name,
        "service.component": component,
        "deployment.environment": settings.vms_env,
    })
    sampler = TraceIdRatioBased(max(0.0, min(1.0, float(settings.vms_otel_sample_ratio))))
    provider = TracerProvider(resource=resource, sampler=sampler)
    if settings.vms_otel_endpoint:
        exporter = OTLPSpanExporter(endpoint=settings.vms_otel_endpoint, insecure=True)
        provider.add_span_processor(BatchSpanProcessor(exporter))
    else:
        log.warning(
            "OTel enabled but VMS_OTEL_ENDPOINT is empty; spans are recorded "
            "but never exported. Set the OTLP collector endpoint to ship data.",
        )
    trace.set_tracer_provider(provider)
    _TRACER = trace.get_tracer(settings.vms_otel_service_name)
    _PROPAGATOR = TraceContextTextMapPropagator()
    _INITIALIZED = component
    log.info(
        "tracing initialized",
        component=component,
        endpoint=settings.vms_otel_endpoint or "(no exporter)",
        sample=settings.vms_otel_sample_ratio,
    )

    _bind_logs_to_spans()


def _bind_logs_to_spans() -> None:
    """Add a structlog processor that copies the active span's
    trace_id/span_id into every log record. Cheap when there's no active
    span (returns immediately)."""
    try:
        import structlog
        from opentelemetry import trace as _trace
    except ImportError:
        return

    def _add_trace_context(_logger, _method, event_dict):
        span = _trace.get_current_span()
        if span is None:
            return event_dict
        ctx = span.get_span_context()
        if not ctx or not ctx.is_valid:
            return event_dict
        # 32-hex trace id, 16-hex span id; cheap to format.
        event_dict.setdefault("trace_id", f"{ctx.trace_id:032x}")
        event_dict.setdefault("span_id", f"{ctx.span_id:016x}")
        return event_dict

    try:
        existing = structlog.get_config().get("processors", [])
        if _add_trace_context not in existing:
            structlog.configure(processors=list(existing) + [_add_trace_context])
    except Exception:
        # structlog not configured yet; the configure_logging() path will pick
        # up a re-init the next time it runs. Best-effort is fine here.
        pass


# ────────────────────────────────────────────────────────────────────────────
# Auto-instrumentations (called by callers that own the underlying object)
# ────────────────────────────────────────────────────────────────────────────


def instrument_fastapi(app: Any) -> None:
    if _TRACER is None:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app)
    except Exception as e:
        log.warning("FastAPI instrumentation failed", err=str(e))


def instrument_sqlalchemy(engine: Any) -> None:
    if _TRACER is None:
        return
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
        # SQLAlchemy auto-instrumentation hooks are global; pass our engine
        # so spans get the right db.system attribute.
        SQLAlchemyInstrumentor().instrument(engine=getattr(engine, "sync_engine", engine))
    except Exception as e:
        log.warning("SQLAlchemy instrumentation failed", err=str(e))


def instrument_redis() -> None:
    if _TRACER is None:
        return
    try:
        from opentelemetry.instrumentation.redis import RedisInstrumentor
        RedisInstrumentor().instrument()
    except Exception as e:
        log.warning("Redis instrumentation failed", err=str(e))


# ────────────────────────────────────────────────────────────────────────────
# Hot-path manual spans
# ────────────────────────────────────────────────────────────────────────────


@contextlib.contextmanager
def traced(name: str, **attrs: Any) -> Iterator[Any]:
    """Context manager wrapping `tracer.start_as_current_span`. No-op when
    tracing is disabled. Use sparingly on the hot path — every span allocates."""
    if _TRACER is None:
        yield None
        return
    with _TRACER.start_as_current_span(name) as span:
        for k, v in attrs.items():
            try:
                span.set_attribute(k, v if isinstance(v, (str, int, float, bool)) else str(v))
            except Exception:
                pass
        yield span


# ────────────────────────────────────────────────────────────────────────────
# Cross-process propagation (used by infra/redis_bus.py)
# ────────────────────────────────────────────────────────────────────────────


_TRACE_KEY = "_trace"   # reserved field on FaceCandidate.extra


def inject_context(carrier: dict) -> dict:
    """Mutates `carrier` in place to add a `_trace` field carrying the W3C
    traceparent + tracestate of the active span. Returns the same dict for
    chaining. No-op when tracing is disabled."""
    if _PROPAGATOR is None:
        return carrier
    headers: dict[str, str] = {}
    _PROPAGATOR.inject(headers)
    if headers:
        carrier[_TRACE_KEY] = headers
    return carrier


def extract_context(carrier: dict) -> Any:
    """Inverse of inject_context. Returns an OTel Context (or None) suitable
    for `with trace.use_span(span, end_on_exit=False)` / `traced(...)` to
    parent against. Quietly returns None when tracing is disabled or the
    carrier has no traceparent."""
    if _PROPAGATOR is None:
        return None
    headers = carrier.get(_TRACE_KEY) if isinstance(carrier, dict) else None
    if not headers:
        return None
    try:
        return _PROPAGATOR.extract(headers)
    except Exception:
        return None


@contextlib.contextmanager
def use_extracted(name: str, ctx: Any, **attrs: Any) -> Iterator[Any]:
    """Open a new span as a child of an extracted context. Pair with
    `extract_context()` on the consumer side of a stream/queue."""
    if _TRACER is None or ctx is None:
        # Still emit a span if we have a tracer, just without the parent link.
        with traced(name, **attrs) as span:
            yield span
        return
    with _TRACER.start_as_current_span(name, context=ctx) as span:
        for k, v in attrs.items():
            try:
                span.set_attribute(k, v if isinstance(v, (str, int, float, bool)) else str(v))
            except Exception:
                pass
        yield span


def shutdown_tracing() -> None:
    """Flush + shutdown the tracer provider. Called from process shutdown
    paths so in-flight spans aren't dropped."""
    if _TRACER is None:
        return
    try:
        from opentelemetry import trace
        provider = trace.get_tracer_provider()
        if hasattr(provider, "shutdown"):
            provider.shutdown()
    except Exception as e:
        log.warning("OTel shutdown failed", err=str(e))


# Silence the OTLP exporter's chatty INFO logs unless we're at DEBUG level.
logging.getLogger("opentelemetry.exporter.otlp").setLevel(logging.WARNING)
