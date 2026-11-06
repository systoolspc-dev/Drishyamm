"""ReportLab PDF investigation report for one stitch job.

Ported from person-tracker. Made SYNC (was async but did blocking I/O): the RQ
worker calls it directly; the async report route offloads it via run_in_executor.
MinIO access goes through vms_face ObjectStore (put_bytes / get_bytes /
parse_s3_uri) instead of person-tracker's private minio_store._get()."""
from __future__ import annotations

import datetime as dt
import io
import json

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas
from reportlab.platypus import (Image, Paragraph, SimpleDocTemplate, Spacer,
                                Table, TableStyle)

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.minio_store import get_object_store
from vms_face.journey.timefmt import fmt_local

log = get_logger(__name__)


def render_for_job(job: dict, *, key: str) -> None:
    """Build the PDF in memory and write it to MinIO under `key` (sync)."""
    request = json.loads(job.get("request") or "{}")
    sightings = request.get("sightings", [])

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm,
                            title=f"drisyam journey — {job['job_id']}")
    styles = getSampleStyleSheet()
    story: list = []

    story.append(Paragraph("<b>drisyam Journey — Investigation Report</b>", styles["Title"]))
    story.append(Spacer(1, 0.4*cm))
    story.append(Paragraph(f"Job ID: {job['job_id']}", styles["Normal"]))
    if job.get("journey_id"):
        story.append(Paragraph(f"Journey ID: {job['journey_id']}", styles["Normal"]))
    story.append(Paragraph(f"Generated: {dt.datetime.now(dt.timezone.utc).isoformat()}", styles["Normal"]))
    story.append(Paragraph(f"Sightings: {len(sightings)}", styles["Normal"]))
    story.append(Spacer(1, 1.0*cm))

    story.append(Paragraph("<b>Timeline of sightings</b>", styles["Heading2"]))
    story.append(Spacer(1, 0.3*cm))

    rows: list[list] = [["Thumb", "Camera", "Time", "Duration", "Match"]]
    for s in sightings:
        thumb = _fetch_thumbnail_flowable(s.get("best_snapshot_uri"))
        started = s.get("started_at", "")
        dur = _humanise_duration(started, s.get("ended_at", ""))
        camera = s.get("camera_code") or s.get("camera_id", "?")
        match = f"{round(100 * float(s.get('best_similarity', 0)))}%"
        rows.append([thumb, camera, fmt_local(started), dur, match])  # local-tz display

    t = Table(rows, colWidths=[2.5*cm, 4*cm, 5*cm, 2.5*cm, 1.5*cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F7983A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFAFA")]),
    ]))
    story.append(t)

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    pdf_bytes = buf.getvalue()
    get_object_store().put_bytes(settings.minio_bucket_output, key, pdf_bytes, "application/pdf")
    log.info("rendered report", key=key, bytes=len(pdf_bytes))


def _humanise_duration(started: str, ended: str) -> str:
    try:
        s = dt.datetime.fromisoformat(started.replace("Z", "+00:00"))
        e = dt.datetime.fromisoformat(ended.replace("Z", "+00:00"))
        secs = int((e - s).total_seconds())
        return f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60}s"
    except Exception:
        return "?"


def _fetch_thumbnail_flowable(snapshot_uri: str | None) -> object:
    """Embed the snapshot thumbnail; on any failure return a placeholder so a
    single missing snapshot doesn't sink the report."""
    placeholder = Paragraph("—", getSampleStyleSheet()["Normal"])
    if not snapshot_uri:
        return placeholder
    store = get_object_store()
    bucket, key = store.parse_s3_uri(snapshot_uri)
    if not bucket or not key:
        return placeholder
    try:
        data = store.get_bytes(bucket, key)
        return Image(io.BytesIO(data), width=2*cm, height=2*cm, kind="proportional")
    except Exception as e:
        log.debug("thumb fetch failed", uri=snapshot_uri, err=str(e))
        return placeholder


def _footer(canv: canvas.Canvas, doc) -> None:
    canv.setFont("Helvetica", 8)
    canv.setFillColor(colors.grey)
    canv.drawRightString(doc.pagesize[0] - 1.5*cm, 1*cm, f"page {doc.page} — drisyam VMS")
