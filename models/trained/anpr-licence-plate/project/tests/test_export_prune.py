"""prune_exports: keeps recent days, removes old host copies, never removes a host-only day."""

import os
from datetime import datetime, timezone

import export_records as er

NOW = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)  # 13:30 IST on 5 Oct


def _day(base, name, payload=b"x" * 1000):
    d = os.path.join(base, name, "cam")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "a.jpg"), "wb") as f:
        f.write(payload)


def test_prune_keeps_recent_and_host_only(tmp_path):
    export, records = tmp_path / "export", tmp_path / "records"
    for d in ["2026-08-31", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]:
        _day(str(export / "records"), d)
    for d in ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]:  # 08-31 is host-only
        _day(str(records), d)

    r = er.prune_exports(keep_days=3, export_dir=str(export), records_dir=str(records), now=NOW, log=lambda m: None)

    left = sorted(os.listdir(export / "records"))
    assert r["removed"] == ["2026-10-01", "2026-10-02"]
    assert r["kept_host_only"] == ["2026-08-31"]
    assert left == ["2026-08-31", "2026-10-03", "2026-10-04", "2026-10-05"]
    assert r["bytes"] == 2000


def test_prune_dry_run_deletes_nothing(tmp_path):
    export, records = tmp_path / "export", tmp_path / "records"
    for d in ["2026-09-01", "2026-10-05"]:
        _day(str(export / "records"), d)
        _day(str(records), d)
    r = er.prune_exports(
        keep_days=2, export_dir=str(export), records_dir=str(records), now=NOW, dry_run=True, log=lambda m: None
    )
    assert r["removed"] == ["2026-09-01"] and r["dry_run"]
    assert sorted(os.listdir(export / "records")) == ["2026-09-01", "2026-10-05"]


def test_prune_off_when_keep_days_below_one(tmp_path):
    export = tmp_path / "export"
    _day(str(export / "records"), "2026-09-01")
    r = er.prune_exports(keep_days=0, export_dir=str(export), records_dir=str(tmp_path), now=NOW, log=lambda m: None)
    assert r["removed"] == [] and os.path.isdir(export / "records" / "2026-09-01")
