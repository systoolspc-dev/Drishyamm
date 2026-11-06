"""
retention.py — storage policy for the ANPR worker's on-disk evidence.

The worker writes, per confirmed plate, under data/records/<date>/<camera>/
    <HHMMSS>_<plate>.jpg         vehicle snapshot            kind "snapshot"
    <HHMMSS>_<plate>_frame.jpg   full frame (detector train)  kind "snapshot"
    <HHMMSS>_<plate>_plate.jpg   plate crop                  kind "crop"
    <HHMMSS>_<plate>.mp4         H.264 clip                  kind "clip"
    <HHMMSS>_<plate>.json        metadata (+ watch_hit)      kind "json"
plus the crop queues data/review/<YYYY-MM-DD>/ (unresolved tracks; legacy flat
files directly under data/review/ still honoured) and flat data/confirmed/.

`sweep()` deletes files older than the per-kind number of days (by mtime).
    * A record whose .json says watch_hit (or labelled / label — honoured when
      present; the worker does not write those keys today) keeps ALL its files
      for days["hit"] (365 d default): evidence an officer may still need.
    * Anything younger than MIN_AGE_S (120 s) is never touched — an .mp4 may
      still be encoding, a .json may be mid-write.
    * data/outbox is never visited (undelivered sightings live there).
    * Empty <camera> / <date> folders are removed afterwards.
    * days[kind] <= 0 disables deletion for that kind.
review/ : nothing trains on it (auto_retrain → export_labels reads records/
    *.json + _frame.jpg and the backend's officer labels); night_report.py and
    eval_night.py read it. It was the largest tree on disk (35k flat files —
    an os.walk took 377 s on the bind mount), so since 2026-08-28 the worker
    writes it per UTC date and the sweep judges whole date folders by name
    (storage-perf spec §A.3); swept at days["review"] (30 d).
confirmed/ : duplicate plate crops of the records → days["crop"].

`start_sweeper()` runs it on a daemon thread every 6 h (first run 60 s after
start) and logs counts + bytes per kind, "(dry run)" when ANPR_RETENTION_DRY_RUN=1.
Run it ONCE per host — the worker starts it in main() before spawning shards.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

MIN_AGE_S = 120.0  # never touch files younger than this
_DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_KEEP_KEYS = ("watch_hit", "labelled", "label")  # truthy in the .json → long retention


def days_from_env() -> dict:
    """Per-kind retention in days from the ANPR_RETAIN_* environment."""

    def _d(name: str, default: str) -> float:
        try:
            return float(os.getenv(name, default))
        except ValueError:
            return float(default)

    return {
        "crop": _d("ANPR_RETAIN_CROPS_DAYS", "90"),
        "snapshot": _d("ANPR_RETAIN_SNAPSHOTS_DAYS", "30"),
        "clip": _d("ANPR_RETAIN_CLIPS_DAYS", "30"),
        "json": _d("ANPR_RETAIN_JSON_DAYS", os.getenv("ANPR_RETAIN_CROPS_DAYS", "90")),
        "hit": _d("ANPR_RETAIN_HIT_DAYS", "365"),
        "review": _d("ANPR_RETAIN_REVIEW_DAYS", "30"),
    }


def kind_of(filename: str) -> str | None:
    """Suffix rules (spec §3). None = not ours, leave alone."""
    f = filename.lower()
    if f.endswith("_plate.jpg"):
        return "crop"
    if f.endswith(".jpg") or f.endswith(".jpeg"):  # <base>.jpg and <base>_frame.jpg
        return "snapshot"
    if f.endswith(".mp4"):
        return "clip"
    if f.endswith(".json"):
        return "json"
    return None


def record_base(filename: str) -> str:
    """'HHMMSS_PLATE_plate.jpg' → 'HHMMSS_PLATE' (shared by every file of a record)."""
    for suf in ("_plate.jpg", "_frame.jpg", ".jpg", ".jpeg", ".mp4", ".json"):
        if filename.lower().endswith(suf):
            return filename[: -len(suf)]
    return os.path.splitext(filename)[0]


_EPOCH_TOKEN = re.compile(r"(?<!\d)(1[5-9]\d{8}|2\d{9})(?!\d)")  # 10-digit unix seconds, 2017..2033


def _name_epoch(filename: str) -> float | None:
    """Write time embedded in a queue filename (review: <cam>_<epoch>_<tid>_<text>,
    confirmed: <plate>_<cam>_<epoch>). None when the name carries no epoch."""
    toks = _EPOCH_TOKEN.findall(filename)
    return max(float(t) for t in toks) if toks else None


def _folder_date_epoch(date_name: str) -> float | None:
    """records/<YYYY-MM-DD> → epoch of that local midnight, None when not a date."""
    if not _DATE_DIR.match(date_name):
        return None
    try:
        return time.mktime(time.strptime(date_name, "%Y-%m-%d"))
    except (ValueError, OverflowError):
        return None


def _keep_long(json_path: str) -> bool:
    """True when the record's metadata marks it as evidence to keep (watch_hit / labelled)."""
    try:
        with open(json_path, encoding="utf-8") as f:
            rec = json.load(f)
    except Exception:  # noqa: BLE001 — unreadable / partial json: be conservative, keep
        return os.path.exists(json_path)
    if not isinstance(rec, dict):
        return False
    return any(bool(rec.get(k)) for k in _KEEP_KEYS)


def _empty_summary() -> dict:
    return {"deleted": 0, "bytes": 0, "kept_hit": 0, "young": 0, "errors": 0}


def _remove(path: str, dry_run: bool) -> int:
    """Delete one file; returns its size (0 on failure)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return 0
    if dry_run:
        return size
    try:
        os.remove(path)
        return size
    except OSError:
        return 0


def _sweep_records(records_dir: str, days: dict, dry_run: bool, now: float, out: dict) -> None:
    if not records_dir or not os.path.isdir(records_dir):
        return
    hit_days = float(days.get("hit", 365) or 0)
    limits = [float(days.get(k, 0) or 0) for k in ("crop", "snapshot", "clip", "json")]
    limits = [x for x in limits if x > 0]
    if not limits:
        return  # every kind disabled
    min_days = min(limits)
    for date_name in sorted(os.listdir(records_dir)):
        date_dir = os.path.join(records_dir, date_name)
        if not os.path.isdir(date_dir) or "outbox" in date_name:
            continue
        # A date folder younger than the shortest limit (2-day timezone slack)
        # cannot hold an expired file: skip it without stat'ing anything — on a
        # bind mount that is the difference between seconds and minutes.
        d0 = _folder_date_epoch(date_name)
        if d0 is not None and (now - d0) < (min_days - 2) * 86400:
            continue
        for cam_name in sorted(os.listdir(date_dir)):
            cam_dir = os.path.join(date_dir, cam_name)
            if not os.path.isdir(cam_dir) or "outbox" in cam_name:
                continue
            try:
                entries = list(os.scandir(cam_dir))  # one stat per file (bind mounts are slow)
            except OSError:
                continue
            keep_cache: dict[str, bool] = {}
            for ent in entries:
                name = ent.name
                kind = kind_of(name)
                if kind is None:
                    continue
                path = ent.path
                try:
                    if not ent.is_file():
                        continue
                    st = ent.stat()
                except OSError:
                    continue
                age = now - st.st_mtime
                k = out.setdefault(kind, _empty_summary())
                if age < MIN_AGE_S:
                    k["young"] += 1
                    continue
                limit_days = float(days.get(kind, 0) or 0)
                if limit_days <= 0:
                    continue
                base = record_base(name)
                if base not in keep_cache:
                    keep_cache[base] = _keep_long(os.path.join(cam_dir, base + ".json"))
                if keep_cache[base]:
                    if hit_days <= 0 or age < hit_days * 86400:
                        k["kept_hit"] += 1
                        continue
                elif age < limit_days * 86400:
                    continue
                size = _remove(path, dry_run)
                if size or dry_run:
                    k["deleted"] += 1
                    k["bytes"] += size
                else:
                    k["errors"] += 1
            if not dry_run:
                _rmdir_if_empty(cam_dir, out)
        if not dry_run and _DATE_DIR.match(date_name):
            _rmdir_if_empty(date_dir, out)


def _sweep_flat(
    folder: str, kind: str, limit_days: float, dry_run: bool, now: float, out: dict, dated: bool = False
) -> None:
    """A queue folder (review/, confirmed/): every .jpg/.json older than limit_days goes.
    dated=True (review/, storage-perf spec §A.3): the files live in
    <folder>/<YYYY-MM-DD>/ (UTC). Each date folder is judged by its NAME first —
    a folder younger than the limit is skipped without a single stat, an
    expired one is emptied and removed; legacy flat files directly under
    <folder> are swept the old way. Never os.walk()s the tree."""
    if not folder or not os.path.isdir(folder) or limit_days <= 0 or "outbox" in os.path.basename(folder):
        return
    k = out.setdefault(kind, _empty_summary())
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return
    if dated:
        for ent in entries:
            if not _DATE_DIR.match(ent.name):
                continue
            try:
                if not ent.is_dir():
                    continue
            except OSError:
                continue
            d0 = _folder_date_epoch(ent.name)
            # the newest file in a date folder was written before the NEXT
            # midnight (+1 day of slack for clock/timezone) → skip it unstat'ed
            if d0 is not None and (now - (d0 + 2 * 86400)) < limit_days * 86400:
                continue
            _sweep_flat_files(ent.path, k, limit_days, dry_run, now)
            if not dry_run:
                _rmdir_if_empty(ent.path, out)
        entries = [e for e in entries if not _DATE_DIR.match(e.name)]
    _sweep_flat_entries(entries, k, limit_days, dry_run, now)


def _sweep_flat_files(folder: str, k: dict, limit_days: float, dry_run: bool, now: float) -> None:
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return
    _sweep_flat_entries(entries, k, limit_days, dry_run, now)


def _sweep_flat_entries(entries, k: dict, limit_days: float, dry_run: bool, now: float) -> None:
    for ent in entries:
        if kind_of(ent.name) is None:
            continue
        # name says it was written recently → cannot be expired; skip the stat
        # (mtime stays the authority for every file actually examined)
        ne = _name_epoch(ent.name)
        if ne is not None and (now - ne) < limit_days * 86400:
            continue
        path = ent.path
        try:
            if not ent.is_file():
                continue
            st = ent.stat()
        except OSError:
            continue
        age = now - st.st_mtime
        if age < MIN_AGE_S:
            k["young"] += 1
            continue
        if age < limit_days * 86400:
            continue
        size = _remove(path, dry_run)
        if size or dry_run:
            k["deleted"] += 1
            k["bytes"] += size
        else:
            k["errors"] += 1


def _rmdir_if_empty(path: str, out: dict) -> None:
    try:
        if os.path.isdir(path) and not os.listdir(path):
            os.rmdir(path)
            out["dirs_removed"] = out.get("dirs_removed", 0) + 1
    except OSError:
        pass


def sweep(
    records_dir: str, review_dir: str | None, confirmed_dir: str | None, days: dict, dry_run: bool = False
) -> dict:
    """Apply the policy once. Returns
    {kind: {deleted, bytes, kept_hit, young, errors}, dirs_removed, dry_run, seconds}."""
    t0 = time.time()
    now = t0
    out: dict = {}
    _sweep_records(records_dir, days, dry_run, now, out)
    _sweep_flat(review_dir, "review", float(days.get("review", 30) or 0), dry_run, now, out, dated=True)
    _sweep_flat(confirmed_dir, "confirmed", float(days.get("crop", 90) or 0), dry_run, now, out)
    out.setdefault("dirs_removed", 0)
    out["dry_run"] = bool(dry_run)
    out["seconds"] = round(time.time() - t0, 2)
    return out


def _mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def format_report(res: dict, days: dict) -> str:
    parts = []
    for kind in ("crop", "snapshot", "clip", "json"):
        k = res.get(kind)
        if k:
            parts.append(f"{kind} {k['deleted']}/{_mb(k['bytes'])} (>{days.get(kind, 0):g}d)")
    rv = res.get("review")
    if rv:
        parts.append(
            f"review {rv['deleted']}/{_mb(rv['bytes'])} (>{days.get('review', 30):g}d; nothing trains on review/)"
        )
    cf = res.get("confirmed")
    if cf:
        parts.append(f"confirmed {cf['deleted']}/{_mb(cf['bytes'])}")
    kept = sum(v.get("kept_hit", 0) for v in res.values() if isinstance(v, dict))
    errs = sum(v.get("errors", 0) for v in res.values() if isinstance(v, dict))
    tail = f"; kept {kept} hit/labelled files for {days.get('hit', 365):g}d; removed {res.get('dirs_removed', 0)} empty dirs"
    if errs:
        tail += f"; {errs} delete errors"
    tail += f"; {res.get('seconds', 0)}s"
    if res.get("dry_run"):
        tail += " (dry run)"
    return "retention: " + (", ".join(parts) if parts else "nothing to sweep") + tail


def start_sweeper(
    records_dir: str,
    review_dir: str | None,
    confirmed_dir: str | None,
    days: dict,
    dry_run: bool = False,
    log=print,
    every_s: float = 6 * 3600.0,
    first_delay_s: float = 60.0,
) -> threading.Thread:
    """Daemon thread: sweep every `every_s`, first run after `first_delay_s`."""

    def loop():
        time.sleep(first_delay_s)
        while True:
            try:
                res = sweep(records_dir, review_dir, confirmed_dir, days, dry_run)
                log(format_report(res, days))
            except Exception as e:  # noqa: BLE001 — the sweeper must never take the worker down
                log(f"retention: sweep failed: {e.__class__.__name__}: {e}")
            time.sleep(every_s)

    t = threading.Thread(target=loop, daemon=True, name="retention")
    t.start()
    log(
        f"retention: policy crops {days.get('crop', 0):g}d, snapshots {days.get('snapshot', 0):g}d, "
        f"clips {days.get('clip', 0):g}d, json {days.get('json', 0):g}d, review {days.get('review', 0):g}d, "
        f"hits/labelled {days.get('hit', 0):g}d — every {every_s / 3600:g}h, first in {first_delay_s:g}s"
        f"{' (dry run)' if dry_run else ''}"
    )
    return t
