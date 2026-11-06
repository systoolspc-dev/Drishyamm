"""
export_records.py — daily copy of the evidence records to a folder an officer can
open in Explorer.

Since 2026-08-28 the worker's churn folders (data/records, review, confirmed,
outbox, train, reports, tmp) live on the named volume `drisyam_trinetra-anpr-data`
(mounted at /srv/anpr/data) because a Windows bind mount costs ~26 ms per small
file write and 377 s to walk 34k files. The bind mount is kept ONLY as the export
target: ./trinetra-ai/app/anpr_worker/export  ->  /srv/anpr/export.

    run_export(date)   copies  data/records/<date>/**      -> ANPR_EXPORT_DIR/records/<date>/**
                       and     data/reports/* for <date>   -> ANPR_EXPORT_DIR/records/<date>/reports/
                       (a report belongs to <date> when its name contains the date
                        or its mtime falls on that UTC day)
    * sequential, one file at a time, low priority (nice +10, optional sleep between
      files: ANPR_EXPORT_SLEEP_MS) — it runs beside 30 live camera threads;
    * skips a destination file that already exists with the same size (idempotent,
      re-runs cost one stat per file);
    * never copies a source younger than MIN_AGE_S (an .mp4 may still be encoding);
      the next run picks it up;
    * writes to <name>.part then renames, so a half-copied file is never "same size";
    * logs files / MB / seconds per date (log= callable, default print).

Record folders are named by UTC date. A run at 02:30 IST (= 21:00 UTC the previous
day) therefore sees an unfinished UTC folder; the default date set is today and the
two previous days so every folder is completed on a later run.

CLI (in the worker container, ANPR_EXPORT_DIR=/srv/anpr/export):
    docker exec -w /srv/anpr trinetra-anpr-worker python export_records.py                # last 3 days (IST)
    docker exec -w /srv/anpr trinetra-anpr-worker python export_records.py --date 2026-08-27
    docker exec -w /srv/anpr trinetra-anpr-worker python export_records.py --days 7 --dry-run

Worker hook: `start_daily_export(log)` runs a daemon thread that calls
`export_default_dates()` every day at ANPR_EXPORT_HOUR_IST (default "2:30").
The retention thread may instead call `run_export(date)` / `export_default_dates()`
directly; `seconds_until_export_hour()` gives it the wait.

On Windows the result is
    trinetra-ai\\app\\anpr_worker\\export\\records\\<date>\\<camera>\\HHMMSS_PLATE.{jpg,_plate.jpg,_frame.jpg,json,mp4}
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("ANPR_DATA_DIR", os.path.join(HERE, "data"))
RECORDS_DIR = os.getenv("ANPR_RECORDS_DIR", os.path.join(DATA_DIR, "records"))
REPORTS_DIR = os.getenv("ANPR_REPORTS_DIR", os.path.join(DATA_DIR, "reports"))
EXPORT_DIR = os.getenv(
    "ANPR_EXPORT_DIR", "/srv/anpr/export" if os.path.isdir("/srv/anpr") else os.path.join(HERE, "export")
)
EXPORT_HOUR_IST = os.getenv("ANPR_EXPORT_HOUR_IST", "2:30")
SLEEP_MS = float(os.getenv("ANPR_EXPORT_SLEEP_MS", "0") or 0)
DEFAULT_DAYS_BACK = int(os.getenv("ANPR_EXPORT_DAYS", "2") or 2)  # today + N previous days

MIN_AGE_S = 120.0  # same rule as retention.py: never touch a file this young
IST = timezone(timedelta(hours=5, minutes=30))
_PROGRESS_EVERY_S = 30.0


# ── dates ────────────────────────────────────────────────────────────────────


def default_dates(now: datetime | None = None, days_back: int = DEFAULT_DAYS_BACK) -> list[str]:
    """[day-N … yesterday, today] as YYYY-MM-DD in IST (folder names are UTC dates,
    so the oldest one is included to finish the previous UTC folder)."""
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(IST).date()
    return [(today - timedelta(days=d)).isoformat() for d in range(days_back, -1, -1)]


def _parse_hour(spec: str) -> tuple[int, int]:
    try:
        h, _, m = spec.strip().partition(":")
        hh, mm = int(h), int(m or 0)
        if 0 <= hh < 24 and 0 <= mm < 60:
            return hh, mm
    except ValueError:
        pass
    return 2, 30


def seconds_until_export_hour(now: datetime | None = None, hour_ist: str = EXPORT_HOUR_IST) -> float:
    """Seconds from `now` to the next ANPR_EXPORT_HOUR_IST (a wall-clock time in IST)."""
    now = (now or datetime.now(timezone.utc)).astimezone(IST)
    hh, mm = _parse_hour(hour_ist)
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return max(1.0, (target - now).total_seconds())


# ── copying ──────────────────────────────────────────────────────────────────


def _mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def _copy_one(src: str, dst: str, size: int, dry_run: bool) -> None:
    """copy src → dst.part → rename. Timestamps are best-effort (bind mounts may refuse)."""
    if dry_run:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    part = dst + ".part"
    try:
        shutil.copyfile(src, part)
        try:
            st = os.stat(src)
            os.utime(part, (st.st_atime, st.st_mtime))
        except OSError:
            pass
        os.replace(part, dst)
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise


def _copy_tree(
    src_root: str,
    dst_root: str,
    stats: dict,
    now: float,
    dry_run: bool,
    log,
    tag: str,
    only_files: set[str] | None = None,
) -> None:
    """Walk src_root sequentially and copy into dst_root, skipping same-size files."""
    if not os.path.isdir(src_root):
        return
    last_report = time.time()
    for dirpath, dirnames, filenames in os.walk(src_root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, src_root)
        dst_dir = dst_root if rel_dir == "." else os.path.join(dst_root, rel_dir)
        try:
            dst_entries = {e.name: e for e in os.scandir(dst_dir)} if os.path.isdir(dst_dir) else {}
        except OSError:
            dst_entries = {}
        for name in sorted(filenames):
            if only_files is not None and name not in only_files:
                continue
            if name.endswith(".part"):
                continue
            src = os.path.join(dirpath, name)
            try:
                st = os.stat(src)
            except OSError:
                stats["errors"] += 1
                continue
            stats["seen"] += 1
            if now - st.st_mtime < MIN_AGE_S:
                stats["young"] += 1
                continue
            ent = dst_entries.get(name)
            if ent is not None:
                try:
                    if ent.is_file() and ent.stat().st_size == st.st_size:
                        stats["skipped"] += 1
                        continue
                except OSError:
                    pass
            try:
                _copy_one(src, os.path.join(dst_dir, name), st.st_size, dry_run)
                stats["copied"] += 1
                stats["bytes"] += st.st_size
            except OSError as e:
                stats["errors"] += 1
                if stats["errors"] <= 5:
                    log(f"export: {tag}: cannot copy {os.path.relpath(src, src_root)}: {e}")
            if SLEEP_MS > 0:
                time.sleep(SLEEP_MS / 1000.0)
            if time.time() - last_report > _PROGRESS_EVERY_S:
                last_report = time.time()
                log(
                    f"export: {tag}: … {stats['copied']} copied / {stats['skipped']} same-size / "
                    f"{_mb(stats['bytes'])} so far"
                )


def _reports_for_date(reports_dir: str, date: str) -> set[str]:
    """Report files that belong to <date>: name contains it, or mtime is on that UTC day."""
    out: set[str] = set()
    if not os.path.isdir(reports_dir):
        return out
    try:
        entries = list(os.scandir(reports_dir))
    except OSError:
        return out
    compact = date.replace("-", "")  # rehearsal_20260828_1528.txt
    for ent in entries:
        try:
            if not ent.is_file():
                continue
            if date in ent.name or compact in ent.name:
                out.add(ent.name)
                continue
            mday = datetime.fromtimestamp(ent.stat().st_mtime, tz=timezone.utc).date().isoformat()
            if mday == date:
                out.add(ent.name)
        except OSError:
            continue
    return out


def _new_stats() -> dict:
    return {"seen": 0, "copied": 0, "skipped": 0, "young": 0, "errors": 0, "bytes": 0}


def run_export(
    date: str,
    export_dir: str | None = None,
    records_dir: str | None = None,
    reports_dir: str | None = None,
    dry_run: bool = False,
    log=print,
) -> dict:
    """Export one UTC record date. Returns
    {date, dest, seen, copied, skipped, young, errors, bytes, seconds, missing}."""
    t0 = time.time()
    export_dir = export_dir or EXPORT_DIR
    records_dir = records_dir or RECORDS_DIR
    reports_dir = reports_dir or REPORTS_DIR
    src = os.path.join(records_dir, date)
    dst = os.path.join(export_dir, "records", date)
    stats = _new_stats()
    stats.update({"date": date, "dest": dst, "missing": not os.path.isdir(src), "dry_run": dry_run})
    now = time.time()
    if not stats["missing"]:
        _copy_tree(src, dst, stats, now, dry_run, log, tag=date)
    reps = _reports_for_date(reports_dir, date)
    if reps:
        _copy_tree(
            reports_dir,
            os.path.join(dst, "reports"),
            stats,
            now,
            dry_run,
            log,
            tag=f"{date}/reports",
            only_files=reps,
        )
    stats["seconds"] = round(time.time() - t0, 1)
    log(format_report(stats))
    return stats


def format_report(s: dict) -> str:
    head = f"export: records/{s['date']} → {s['dest']}: "
    if s.get("missing") and s["seen"] == 0:
        return head + f"no such record folder (0 files) — {s['seconds']}s"
    body = (
        f"{s['copied']} copied ({_mb(s['bytes'])}), {s['skipped']} already there (same size), "
        f"{s['young']} too young, {s['errors']} errors, {s['seen']} seen — {s['seconds']}s"
    )
    if s.get("dry_run"):
        body += " (dry run)"
    return head + body


# ── pruning the host copy ────────────────────────────────────────────────────
#
# 5 Oct 2026: the export is a COPY of the volume (records are authoritative in
# data/records/), and it grew 20-40 GB a day until the disk hit 0 GB free
# (docs/security/SECURITY.md P0-4). Keep only the last KEEP_DAYS dates on the
# host. A date is removed ONLY when the same date still exists in RECORDS_DIR,
# so a host-only day (2026-08-31 exists nowhere else) is never deleted.
KEEP_DAYS = int(os.getenv("ANPR_EXPORT_KEEP_DAYS", str(DEFAULT_DAYS_BACK + 1)) or (DEFAULT_DAYS_BACK + 1))


def _dir_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def prune_exports(
    keep_days: int = KEEP_DAYS,
    export_dir: str | None = None,
    records_dir: str = RECORDS_DIR,
    dry_run: bool = False,
    log=print,
    now: datetime | None = None,
) -> dict:
    """Delete host export dates older than the newest `keep_days` IST days, but only
    dates that still exist on the volume. Returns what was (or would be) removed."""
    base = os.path.join(export_dir or EXPORT_DIR, "records")
    keep = set(default_dates(now=now, days_back=max(0, keep_days - 1)))
    removed, kept_host_only, freed = [], [], 0
    if keep_days < 1 or not os.path.isdir(base):
        return {"removed": removed, "kept_host_only": kept_host_only, "bytes": 0, "dry_run": dry_run}
    for name in sorted(os.listdir(base)):
        full = os.path.join(base, name)
        if not os.path.isdir(full) or len(name) != 10 or name in keep or name > max(keep):
            continue
        if not os.path.isdir(os.path.join(records_dir, name)):
            kept_host_only.append(name)  # the only copy left: never delete it
            continue
        size = _dir_bytes(full)
        if not dry_run:
            shutil.rmtree(full, ignore_errors=True)
            if os.path.exists(full):
                log(f"export: prune {name} incomplete (files in use?)")
                continue
        removed.append(name)
        freed += size
    verb = "would free" if dry_run else "freed"
    log(
        f"export: prune keeps {keep_days} day(s); removed {removed or 'nothing'}, {verb} {_mb(freed)}"
        + (f"; kept host-only {kept_host_only}" if kept_host_only else "")
    )
    return {"removed": removed, "kept_host_only": kept_host_only, "bytes": freed, "dry_run": dry_run}


def export_default_dates(
    days_back: int = DEFAULT_DAYS_BACK, dry_run: bool = False, log=print, export_dir: str | None = None
) -> list[dict]:
    """Export today (IST) and the previous `days_back` days, then prune old host copies; never raises."""
    out = []
    for d in default_dates(days_back=days_back):
        try:
            out.append(run_export(d, export_dir=export_dir, dry_run=dry_run, log=log))
        except Exception as e:  # noqa: BLE001 — the export must never take the worker down
            log(f"export: {d} failed: {e.__class__.__name__}: {e}")
    total = sum(r.get("copied", 0) for r in out)
    mb = sum(r.get("bytes", 0) for r in out)
    secs = sum(r.get("seconds", 0) for r in out)
    log(f"export: done — {total} files / {_mb(mb)} / {secs:.0f}s → {export_dir or EXPORT_DIR}")
    try:
        prune_exports(export_dir=export_dir, dry_run=dry_run, log=log)
    except Exception as e:  # noqa: BLE001
        log(f"export: prune failed: {e.__class__.__name__}: {e}")
    return out


def _lower_priority() -> None:
    try:
        if hasattr(os, "nice"):
            os.nice(10)
    except OSError:
        pass


def start_daily_export(
    log=print, hour_ist: str = EXPORT_HOUR_IST, days_back: int = DEFAULT_DAYS_BACK
) -> threading.Thread:
    """Daemon thread: run export_default_dates() every day at `hour_ist`."""

    def loop():
        _lower_priority()
        while True:
            wait = seconds_until_export_hour(hour_ist=hour_ist)
            log(f"export: next run in {wait / 3600:.1f} h (at {hour_ist} IST) → {EXPORT_DIR}")
            time.sleep(wait)
            export_default_dates(days_back=days_back, log=log)
            time.sleep(60)  # never fire twice in the same minute

    t = threading.Thread(target=loop, daemon=True, name="export")
    t.start()
    return t


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="copy data/records/<date> (+ reports) to the export folder")
    ap.add_argument("--date", action="append", help="YYYY-MM-DD (UTC folder name); repeatable")
    ap.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS_BACK,
        help=f"without --date: today (IST) and this many previous days (default {DEFAULT_DAYS_BACK})",
    )
    ap.add_argument("--export-dir", default=EXPORT_DIR)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--prune-only",
        action="store_true",
        help=f"only remove host copies older than ANPR_EXPORT_KEEP_DAYS ({KEEP_DAYS}) that still exist on the volume",
    )
    a = ap.parse_args(argv)
    _lower_priority()
    if a.prune_only:
        prune_exports(export_dir=a.export_dir, dry_run=a.dry_run, log=lambda m: print(m, flush=True))
        return 0
    dates = a.date or default_dates(days_back=a.days)
    print(f"export: {RECORDS_DIR} → {a.export_dir} for {', '.join(dates)}", flush=True)
    errors = 0
    total = 0
    for d in dates:
        r = run_export(d, export_dir=a.export_dir, dry_run=a.dry_run, log=lambda m: print(m, flush=True))
        errors += r["errors"]
        total += r["copied"]
    print(f"export: done — {total} files copied, {errors} errors", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
