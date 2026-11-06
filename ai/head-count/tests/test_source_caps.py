"""The concurrency caps defend two different things — prove they stay separate.

Regression: every camera in a pull deployment carries the SAME relay authority
(rtsp://stream-service:8554/cam_x). Capping per-host on that throttled the whole
service to 4 workers while protecting no recorder at all — the relay holds one
upstream session however many readers attach.
"""
from headcount.source import _to_streams


def cam(name, rtsp, enabled=True, **extra):
    return {
        "name": name, "monitorId": name, "rtsp": rtsp,
        "settings": {"headcount": {"enabled": enabled}},
        **extra,
    }


def relay(n):
    return [cam(f"c{i}", f"rtsp://stream-service:8554/cam_{i}") for i in range(n)]


class TestRelayIsExemptFromTheRecorderCap:
    def test_ten_relay_cameras_all_start(self):
        """The bug: these all shared one authority and only 4 ever ran."""
        got = _to_streams(relay(10), prefer_sub=False, max_streams=32, max_per_host=4)
        assert len(got) == 10

    def test_relay_still_bounded_by_our_own_resource_cap(self):
        """max_streams protects OUR gpu — it must keep applying to relays."""
        got = _to_streams(relay(10), prefer_sub=False, max_streams=6, max_per_host=4)
        assert len(got) == 6

    def test_alternate_relay_hostnames_recognised(self):
        cams = [cam(f"c{i}", f"rtsp://mediamtx:8554/cam_{i}") for i in range(8)]
        assert len(_to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)) == 8


class TestRealRecorderIsStillProtected:
    def test_direct_nvr_urls_are_capped(self):
        """The NVR flood incident: 17 concurrent pulls took every camera offline."""
        cams = [cam(f"c{i}", f"rtsp://192.168.1.219:554/ch{i}") for i in range(17)]
        got = _to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)
        assert len(got) == 4

    def test_cap_is_per_recorder_not_global(self):
        cams = ([cam(f"a{i}", f"rtsp://10.0.0.1:554/ch{i}") for i in range(6)]
                + [cam(f"b{i}", f"rtsp://10.0.0.2:554/ch{i}") for i in range(6)])
        got = _to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)
        assert len(got) == 8          # 4 from each recorder

    def test_explicit_host_field_beats_the_url(self):
        """If the backend tells us the real device, trust it over the relay URL."""
        cams = [cam(f"c{i}", f"rtsp://stream-service:8554/cam_{i}", host="192.168.1.219")
                for i in range(9)]
        got = _to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)
        assert len(got) == 4

    def test_mixed_relay_and_direct(self):
        cams = relay(5) + [cam(f"n{i}", f"rtsp://192.168.1.219:554/ch{i}") for i in range(9)]
        got = _to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)
        assert len(got) == 9          # 5 relay (uncapped) + 4 from the recorder


class TestOfflineCamerasAreNotDialled:
    """OpenCV serialises avformat_open_input globally, so one camera stuck in a
    30s open timeout blocks every OTHER camera's connect. Known-dead cameras
    must never reach that lock."""

    def test_vms_offline_cameras_are_skipped(self):
        cams = ([cam(f"d{i}", f"rtsp://stream-service:8554/cam_d{i}", status="offline")
                 for i in range(19)]
                + [cam("live", "rtsp://stream-service:8554/cam_live", status="online")])
        got = _to_streams(cams, prefer_sub=False, max_streams=8, max_per_host=4)
        assert [s.id for s in got] == ["live"]

    def test_offline_cameras_do_not_consume_slots(self):
        """The starvation case: dead cameras must not eat the stream budget."""
        cams = ([cam(f"d{i}", f"rtsp://stream-service:8554/cam_d{i}", status="offline")
                 for i in range(8)]
                + [cam("live", "rtsp://stream-service:8554/cam_live", status="online")])
        assert len(_to_streams(cams, prefer_sub=False, max_streams=8, max_per_host=4)) == 1

    def test_unknown_status_is_still_attempted(self):
        """Fail OPEN — a backend that doesn't report status must keep working."""
        cams = [cam("a", "rtsp://stream-service:8554/cam_a"),
                cam("b", "rtsp://stream-service:8554/cam_b", status=None)]
        assert len(_to_streams(cams, prefer_sub=False, max_streams=8, max_per_host=4)) == 2


class TestSelection:
    def test_disabled_cameras_are_skipped(self):
        cams = relay(3) + [cam("off", "rtsp://stream-service:8554/cam_off", enabled=False)]
        assert len(_to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)) == 3

    def test_camera_without_a_url_is_skipped(self):
        cams = relay(2) + [{"name": "x", "monitorId": "x",
                            "settings": {"headcount": {"enabled": True}}}]
        assert len(_to_streams(cams, prefer_sub=False, max_streams=32, max_per_host=4)) == 2

    def test_prefer_sub_uses_the_sub_stream_when_present(self):
        cams = [cam("c", "rtsp://stream-service:8554/cam_main",
                    rtspSub="rtsp://stream-service:8554/cam_sub")]
        got = _to_streams(cams, prefer_sub=True, max_streams=32, max_per_host=4)
        assert got[0].source.endswith("cam_sub")


class TestCountingZonesFlowThrough:
    """Zones drawn in the VMS must reach the worker unchanged — they are the
    difference between 'people in this room' and 'people this lens can see'."""

    def test_zones_are_carried_from_camera_settings(self):
        c = cam("z", "rtsp://stream-service:8554/cam_z")
        c["settings"]["headcount"]["zones"] = [
            {"id": "room", "points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]]}]
        got = _to_streams([c], prefer_sub=False, max_streams=8, max_per_host=4)
        assert got[0].zones and got[0].zones[0]["id"] == "room"

    def test_no_zones_means_empty_not_missing(self):
        got = _to_streams([cam("z", "rtsp://stream-service:8554/cam_z")],
                          prefer_sub=False, max_streams=8, max_per_host=4)
        assert got[0].zones == []

    def test_malformed_zones_do_not_break_the_camera(self):
        c = cam("z", "rtsp://stream-service:8554/cam_z")
        c["settings"]["headcount"]["zones"] = "not-a-list"
        got = _to_streams([c], prefer_sub=False, max_streams=8, max_per_host=4)
        assert len(got) == 1 and got[0].zones == []


class TestConfigChangesAreDetected:
    """Editing a camera's counting zone leaves its id unchanged. If the poller
    compares id sets, the edit is never applied and the operator's zone silently
    does nothing."""

    def test_same_camera_with_a_new_zone_is_a_different_config(self):
        base = cam("z", "rtsp://stream-service:8554/cam_z")
        a = _to_streams([base], prefer_sub=False, max_streams=8, max_per_host=4)[0]
        changed = cam("z", "rtsp://stream-service:8554/cam_z")
        changed["settings"]["headcount"]["zones"] = [
            {"id": "room", "points": [[0, 0], [1, 0], [1, 1]]}]
        b = _to_streams([changed], prefer_sub=False, max_streams=8, max_per_host=4)[0]
        assert a.id == b.id, "ids match — an id-only comparison would miss this"
        assert a != b, "configs must compare unequal so reconcile restarts the worker"


class TestDetailLevelFlowsThrough:
    def test_valid_level_is_carried(self):
        c = cam("z", "rtsp://stream-service:8554/cam_z")
        c["settings"]["headcount"]["imgsz"] = 1280
        got = _to_streams([c], prefer_sub=False, max_streams=8, max_per_host=4)
        assert got[0].imgsz == 1280

    def test_absent_level_uses_the_service_default(self):
        got = _to_streams([cam("z", "rtsp://stream-service:8554/cam_z")],
                          prefer_sub=False, max_streams=8, max_per_host=4)
        assert got[0].imgsz is None

    def test_nonsense_level_never_takes_a_camera_out_of_service(self):
        """A bad value must fall back to the default, not drop the camera or
        crash the model with an input size it cannot accept."""
        for bad in (777, -1, 0, 'big', None, 99999):
            c = cam("z", "rtsp://stream-service:8554/cam_z")
            c["settings"]["headcount"]["imgsz"] = bad
            got = _to_streams([c], prefer_sub=False, max_streams=8, max_per_host=4)
            assert len(got) == 1, f"camera dropped for imgsz={bad!r}"
            assert got[0].imgsz is None, f"unsafe imgsz={bad!r} accepted"
