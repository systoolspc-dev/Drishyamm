from __future__ import annotations

import csv
import datetime as dt
import json
from pathlib import Path

from vms_face.eval.frvt import DETCurve, compute_det_curve
from vms_face.eval.metrics import GroupMetrics
from vms_face.eval.types import ProbeOutcome


def write_reports(
    *,
    out_dir: Path,
    outcomes: list[ProbeOutcome],
    metrics_by_group: dict[str, GroupMetrics],
    threshold: float,
    gallery_size: int,
    n_persons: int,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)

    overall = metrics_by_group.get("all")
    det_curve = compute_det_curve(outcomes)

    summary = {
        "timestamp": dt.datetime.utcnow().isoformat() + "Z",
        "threshold": threshold,
        "gallery_size": gallery_size,
        "n_persons": n_persons,
        "n_probes": len(outcomes),
        "overall": overall.to_dict() if overall else {},
        "by_group": {k: m.to_dict() for k, m in metrics_by_group.items() if k != "all"},
        "frvt": det_curve.to_dict() if det_curve else None,
    }

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if det_curve:
        (out_dir / "det_curve.json").write_text(json.dumps(det_curve.to_dict(), indent=2), encoding="utf-8")

    _write_outcomes_csv(out_dir / "outcomes.csv", outcomes)
    _write_text_report(out_dir / "report.txt", summary)
    _write_html_report(out_dir / "report.html", summary)
    return summary


def _write_outcomes_csv(path: Path, outcomes: list[ProbeOutcome]) -> None:
    fields = [
        "probe_path",
        "true_person_id",
        "predicted_person_id",
        "similarity",
        "threshold",
        "quality_score",
        "det_score",
        "undetected",
        "rejected_quality",
        "detect_latency_ms",
        "match_latency_ms",
        "tags",
        "error",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for o in outcomes:
            w.writerow(
                {
                    "probe_path": str(o.probe_path),
                    "true_person_id": o.true_person_id or "",
                    "predicted_person_id": o.predicted_person_id or "",
                    "similarity": f"{o.similarity:.4f}" if o.similarity is not None else "",
                    "threshold": f"{o.threshold:.4f}",
                    "quality_score": f"{o.quality_score:.4f}" if o.quality_score is not None else "",
                    "det_score": f"{o.det_score:.4f}" if o.det_score is not None else "",
                    "undetected": int(o.undetected),
                    "rejected_quality": int(o.rejected_quality),
                    "detect_latency_ms": f"{o.detect_latency_ms:.2f}" if o.detect_latency_ms else "",
                    "match_latency_ms": f"{o.match_latency_ms:.2f}" if o.match_latency_ms else "",
                    "tags": ";".join(f"{k}={v}" for k, v in o.tags.items()),
                    "error": o.error or "",
                }
            )


def _write_text_report(path: Path, summary: dict) -> None:
    lines: list[str] = []
    o = summary["overall"]
    lines.append("=" * 70)
    lines.append("VMS FACE PILOT — PIPELINE EVALUATION REPORT")
    lines.append("=" * 70)
    lines.append(f"Timestamp:      {summary['timestamp']}")
    lines.append(f"Threshold:      {summary['threshold']:.3f}")
    lines.append(f"Gallery:        {summary['n_persons']} persons / {summary['gallery_size']} centroids")
    lines.append(f"Probes:         {summary['n_probes']}")
    lines.append("")
    lines.append("OVERALL")
    lines.append("-" * 70)
    if o:
        lines.append(_format_metrics_block(o))
    lines.append("")
    lines.append("BY GROUP")
    lines.append("-" * 70)
    for name, m in summary["by_group"].items():
        lines.append(f"[{name}]  n={m['total']}  tpr={m['tpr_recall']:.3f}  fpr={m['fpr']:.3f}  f1={m['f1']:.3f}  det_rate={m['detection_rate']:.3f}")
    lines.append("")

    frvt = summary.get("frvt")
    if frvt:
        lines.append("NIST FRVT 1:N OPERATING POINTS")
        lines.append("-" * 70)
        lines.append(f"  n_known_probes:   {frvt['n_known']}")
        lines.append(f"  n_unknown_probes: {frvt['n_unknown']}")
        for name, op in frvt["operating_points"].items():
            lines.append(
                f"  [{name}]  threshold={op['threshold']:.3f}  "
                f"FNIR={op['fnir']:.4f}  TPIR={op['tpir']:.4f}  "
                f"observed_FPIR={op['fpir_observed']:.4f}"
            )
        lines.append("")

    lines.append("INTERPRETATION TARGETS")
    lines.append("-" * 70)
    lines.append("  FNIR @ FPIR=1e-3   <= 0.10        -> excellent (NIST FRVT-style)")
    lines.append("  FNIR @ FPIR=1e-3   <= 0.25        -> deployable for campus VMS")
    lines.append("  FNIR @ FPIR=1e-3   >  0.40        -> tune or swap recognizer")
    lines.append("  Detection rate     >= 0.95        -> if lower, detector is the wrong fit")
    lines.append("  TinyFace AdaFace ceiling (open-source SOTA): Rank-1 = 0.7229")
    lines.append("  Real CCTV typically 5-20x worse FNIR than NIST VISA/MUGSHOT.")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def _format_metrics_block(m: dict) -> str:
    rows = [
        ("Total probes", m["total"]),
        ("  positives (known IDs)", m["positives"]),
        ("  negatives (unknowns)", m["negatives"]),
        ("True positives  (TP)", m["tp"]),
        ("False negatives (FN)", m["fn"]),
        ("False positives (FP)", m["fp"]),
        ("True  negatives (TN)", m["tn"]),
        ("Undetected", m["undetected"]),
        ("Quality-rejected", m["rejected_quality"]),
        ("TPR / Recall", f"{m['tpr_recall']:.4f}"),
        ("FPR", f"{m['fpr']:.4f}"),
        ("Precision", f"{m['precision']:.4f}"),
        ("F1", f"{m['f1']:.4f}"),
        ("Detection rate", f"{m['detection_rate']:.4f}"),
        ("Mean similarity", f"{m['mean_similarity']:.4f}"),
        ("Detect p50/p95 (ms)", f"{m.get('detect_ms_p50', 0):.1f} / {m.get('detect_ms_p95', 0):.1f}"),
        ("Match  p50/p95 (ms)", f"{m.get('match_ms_p50', 0):.2f} / {m.get('match_ms_p95', 0):.2f}"),
    ]
    return "\n".join(f"  {k:<28}{v}" for k, v in rows)


def _write_html_report(path: Path, summary: dict) -> None:
    o = summary["overall"]
    rows = "".join(
        f"<tr><td>{name}</td><td>{m['total']}</td><td>{m['tpr_recall']:.3f}</td>"
        f"<td>{m['fpr']:.3f}</td><td>{m['precision']:.3f}</td><td>{m['f1']:.3f}</td>"
        f"<td>{m['detection_rate']:.3f}</td></tr>"
        for name, m in summary["by_group"].items()
    )

    overall_tpr_color = "green" if o.get("tpr_recall", 0) >= 0.85 else ("orange" if o.get("tpr_recall", 0) >= 0.6 else "red")
    overall_fpr_color = "green" if o.get("fpr", 1) <= 0.02 else ("orange" if o.get("fpr", 1) <= 0.05 else "red")

    frvt = summary.get("frvt") or {}
    op_1e3 = (frvt.get("operating_points") or {}).get("fpir=1e-03") or {}
    fnir_1e3 = op_1e3.get("fnir", 0.0) if op_1e3 else None
    fnir_color = "green" if (fnir_1e3 is not None and fnir_1e3 <= 0.10) else ("orange" if (fnir_1e3 is not None and fnir_1e3 <= 0.25) else "red")
    fnir_block = (
        f"<div class='kpi'><div class='label'>FNIR @ FPIR=1e-3</div>"
        f"<div class='value {fnir_color}'>{fnir_1e3:.3f}</div></div>"
        if fnir_1e3 is not None
        else ""
    )

    frvt_rows = ""
    for name, op in (frvt.get("operating_points") or {}).items():
        frvt_rows += (
            f"<tr><td>{name}</td><td>{op['threshold']:.3f}</td>"
            f"<td>{op['fnir']:.4f}</td><td>{op['tpir']:.4f}</td>"
            f"<td>{op['fpir_observed']:.4f}</td></tr>"
        )
    frvt_section = (
        "<h2>NIST FRVT 1:N operating points</h2>"
        "<table><tr><th>Target</th><th>Threshold</th><th>FNIR</th><th>TPIR</th><th>Observed FPIR</th></tr>"
        f"{frvt_rows}</table>"
        if frvt_rows
        else ""
    )

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>VMS Face Pilot Report</title>
<style>
body {{ font-family: -apple-system, sans-serif; max-width: 980px; margin: 2em auto; padding: 0 1em; color: #222; }}
h1 {{ border-bottom: 2px solid #333; padding-bottom: .3em; }}
.kpis {{ display: flex; gap: 1em; flex-wrap: wrap; margin: 1em 0; }}
.kpi {{ background: #f6f6f6; border-radius: 8px; padding: 1em 1.4em; min-width: 140px; }}
.kpi .label {{ font-size: .85em; color: #666; text-transform: uppercase; letter-spacing: .04em; }}
.kpi .value {{ font-size: 1.8em; font-weight: 600; margin-top: .15em; }}
.value.green {{ color: #178a3b; }}
.value.orange {{ color: #c87a00; }}
.value.red {{ color: #c0392b; }}
table {{ width: 100%; border-collapse: collapse; margin: 1em 0; }}
th, td {{ padding: .55em .8em; border-bottom: 1px solid #eee; text-align: left; font-size: .92em; }}
th {{ background: #fafafa; }}
.note {{ background: #fffbe6; border: 1px solid #f3e6a5; padding: .8em 1em; border-radius: 6px; margin-top: 1.5em; }}
</style></head><body>
<h1>VMS Face Pilot — Evaluation Report</h1>
<div>Generated {summary['timestamp']} · threshold = {summary['threshold']:.3f} ·
gallery {summary['n_persons']} persons / {summary['gallery_size']} centroids · {summary['n_probes']} probes</div>

<div class="kpis">
  <div class="kpi"><div class="label">TPR / Recall</div><div class="value {overall_tpr_color}">{o.get('tpr_recall', 0):.3f}</div></div>
  <div class="kpi"><div class="label">FPR</div><div class="value {overall_fpr_color}">{o.get('fpr', 0):.3f}</div></div>
  <div class="kpi"><div class="label">F1</div><div class="value">{o.get('f1', 0):.3f}</div></div>
  {fnir_block}
  <div class="kpi"><div class="label">Detection rate</div><div class="value">{o.get('detection_rate', 0):.3f}</div></div>
  <div class="kpi"><div class="label">Detect p95 (ms)</div><div class="value">{o.get('detect_ms_p95', 0):.0f}</div></div>
</div>

{frvt_section}

<h2>By group</h2>
<table>
<tr><th>Group</th><th>n</th><th>TPR</th><th>FPR</th><th>Precision</th><th>F1</th><th>Det rate</th></tr>
{rows}
</table>

<div class="note">
  <strong>Acceptance bars (NIST FRVT-style, recommended):</strong>
  FNIR @ FPIR=1e-3 ≤ 0.10 excellent · ≤ 0.25 deployable · &gt; 0.40 needs work.
  Detection rate ≥ 0.95 globally. AdaFace open-source ceiling on TinyFace: Rank-1 = 0.7229.
  Real CCTV typically scores 5-20× worse FNIR than NIST VISA/MUGSHOT — measure on your own footage.
</div>

</body></html>"""
    path.write_text(html, encoding="utf-8")
