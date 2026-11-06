"""Per-person activity: working / not_working from body posture.

`working` = sitting upright at the workstation. Decided from **posture**
(torso tilt from vertical + head elevation above the shoulders), which is far more
robust to camera angle than head-facing direction — a person typing in profile on
an overhead CCTV still reads as upright. Elbow height is irrelevant, by design.

Also produces `on_phone` (phone box overlaps the person) and `talking` (two people
near + turned toward each other). Thresholds are config-driven; validate on real
footage with probe_activity.py.
"""

from __future__ import annotations

import logging
import math

from ultralytics import YOLO

from .config import ActivityConfig
from .model import resolve_device
from .tracker import IoUTracker

log = logging.getLogger("activity_monitor.activity")

# COCO pose keypoint indices
NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHO, R_SHO, L_HIP, R_HIP = 5, 6, 11, 12
L_WRIST, R_WRIST = 9, 10

WORKING, NOT_WORKING, ON_PHONE, TALKING, UNKNOWN = (
    "working", "not_working", "on_phone", "talking", "unknown")


def head_yaw(kpts, kpt_conf: float):
    """Head yaw (for the talking check). ~0 = facing forward, ±1 = turned aside."""
    def vis(p):
        return p[2] >= kpt_conf
    nose = kpts[NOSE]
    left = kpts[L_EAR] if vis(kpts[L_EAR]) else (kpts[L_EYE] if vis(kpts[L_EYE]) else None)
    right = kpts[R_EAR] if vis(kpts[R_EAR]) else (kpts[R_EYE] if vis(kpts[R_EYE]) else None)
    if not vis(nose) or left is None or right is None:
        return None, False
    center_x = (left[0] + right[0]) / 2.0
    half = abs(right[0] - left[0]) / 2.0 or 1.0
    return float((nose[0] - center_x) / half), True


def posture_state(kpts, kpt_conf: float, tilt_max: float, head_down: float,
                  face_min: float = 0.45, buried_head: bool = True):
    """Upright (working) vs slumped/reclined (not_working) from UPPER-BODY posture.

    Needs a head keypoint (nose/eye/ear) + both shoulders. Hips usually hidden by a
    desk. Detects:
      * head clearly below the shoulders  -> slumped / head-down (not_working)
      * if hips ARE visible, a reclined torso (big tilt) -> not_working (wide shots)
      * otherwise -> working
    Returns (state, features). UNKNOWN only if no head keypoint or shoulders visible.

    Using any head keypoint (not just the nose) means people facing AWAY from the
    camera — where the nose is hidden but an ear is visible — still get classified.

    Blind spot (accepted): leaning back idle with the head up and hips hidden reads
    as `working` — upper-body geometry can't separate it from sitting upright.
    """
    def vis(p):
        return p[2] >= kpt_conf

    lsh, rsh = kpts[L_SHO], kpts[R_SHO]
    if not (vis(lsh) and vis(rsh)):
        return UNKNOWN, {}

    # Most confident head keypoint (nose, eyes, or ears).
    head = max((kpts[i] for i in (NOSE, L_EYE, R_EYE, L_EAR, R_EAR)), key=lambda p: p[2])

    # Buried-head: clear shoulders but NO confident head keypoint => face hidden
    # (pressed into arms on the desk). Working people always show a clear ear.
    if head[2] < face_min:
        if buried_head and min(lsh[2], rsh[2]) >= 0.5:
            return NOT_WORKING, {"face": "hidden", "head_conf": round(head[2], 2)}
        return UNKNOWN, {}

    sh_y = (lsh[1] + rsh[1]) / 2.0
    sh_x = (lsh[0] + rsh[0]) / 2.0
    sh_w = abs(lsh[0] - rsh[0]) or 1.0

    # head elevation above the shoulders, normalized by shoulder width
    head_lift = (sh_y - head[1]) / sh_w
    feats = {"head_lift": round(head_lift, 2)}

    if head_lift < head_down:                 # nose well below shoulders -> slumped
        return NOT_WORKING, feats

    # Bonus: if hips happen to be visible, catch reclining via torso tilt.
    lhip, rhip = kpts[L_HIP], kpts[R_HIP]
    if vis(lhip) and vis(rhip):
        hip_x = (lhip[0] + rhip[0]) / 2.0
        hip_y = (lhip[1] + rhip[1]) / 2.0
        tilt = math.degrees(math.atan2(abs(sh_x - hip_x), abs(sh_y - hip_y) or 1.0))
        feats["tilt"] = round(tilt, 1)
        if tilt > tilt_max:
            return NOT_WORKING, feats

    return WORKING, feats


class _PersonState:
    """Temporal hysteresis for one tracked person."""
    __slots__ = ("committed", "candidate", "since")

    def __init__(self):
        self.committed = UNKNOWN
        self.candidate = UNKNOWN
        self.since = 0.0

    def update(self, instant: str, now: float, hold: float) -> str:
        if instant == UNKNOWN:              # can't assess this frame → keep last state
            return self.committed
        if instant == self.committed:
            self.candidate = instant
            return self.committed
        if instant != self.candidate:
            self.candidate = instant
            self.since = now
        elif now - self.since >= hold:
            self.committed = instant
        return self.committed


def _phone_overlap(phone_box, person_box) -> float:
    ix1, iy1 = max(phone_box[0], person_box[0]), max(phone_box[1], person_box[1])
    ix2, iy2 = min(phone_box[2], person_box[2]), min(phone_box[3], person_box[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area = (phone_box[2] - phone_box[0]) * (phone_box[3] - phone_box[1])
    return inter / area if area else 0.0


def _phone_near_hand(phone_box, kpts, kpt_conf: float, radius_ratio: float,
                     shoulder_w: float):
    """Is the phone actually being HELD — i.e. near a wrist or the head?

    Returns True/False when we have a usable wrist/head keypoint, or None when we
    have none (the caller then falls back to plain box-overlap so we don't drop a
    genuine phone just because the arms are out of frame). Distance is scaled by
    shoulder width so it works at any camera distance.
    """
    px = (phone_box[0] + phone_box[2]) / 2.0
    py = (phone_box[1] + phone_box[3]) / 2.0
    r2 = (radius_ratio * shoulder_w) ** 2
    anchors = [kpts[i] for i in (L_WRIST, R_WRIST, NOSE, L_EYE, R_EYE, L_EAR, R_EAR)
               if kpts[i][2] >= kpt_conf]
    if not anchors:
        return None
    return any((px - a[0]) ** 2 + (py - a[1]) ** 2 <= r2 for a in anchors)


class ActivityAnalyzer:
    """Stateful per-stream analyzer. One instance per camera."""

    def __init__(self, cfg: ActivityConfig):
        self.cfg = cfg
        self.device = resolve_device(cfg.device)
        log.info("loading pose model %s on %s", cfg.pose_weights, self.device)
        self.pose = YOLO(cfg.pose_weights)
        self.tracker = IoUTracker(
            iou_threshold=cfg.track_iou,
            max_misses=cfg.track_max_misses,
            center_dist_ratio=cfg.track_center_dist_ratio,
        )
        self._states: dict[int, _PersonState] = {}
        self._warmup()

    def _warmup(self):
        import numpy as np
        self.pose.predict(np.zeros((self.cfg.imgsz, self.cfg.imgsz, 3), dtype=np.uint8),
                          device=self.device, imgsz=self.cfg.imgsz, verbose=False)

    def _base_state(self, box, kpts, phone_boxes) -> tuple[str, dict]:
        for pb in phone_boxes:
            if _phone_overlap(pb, box) < self.cfg.phone_overlap:
                continue
            if self.cfg.phone_require_hand:
                lsh, rsh = kpts[L_SHO], kpts[R_SHO]
                have_sh = lsh[2] >= self.cfg.kpt_conf and rsh[2] >= self.cfg.kpt_conf
                sh_w = abs(lsh[0] - rsh[0]) if have_sh else (box[2] - box[0]) * 0.5
                near = _phone_near_hand(pb, kpts, self.cfg.kpt_conf,
                                        self.cfg.phone_hand_radius, sh_w or 1.0)
                if near is False:      # phone in the box but not near a hand/head → desk phone
                    continue
            return ON_PHONE, {}
        return posture_state(kpts, self.cfg.kpt_conf,
                             self.cfg.posture_tilt_max, self.cfg.posture_head_down,
                             self.cfg.posture_face_min, self.cfg.posture_buried_head)

    def _talking_pairs(self, infos) -> list[tuple[int, int]]:
        pairs = []
        conv, prox = self.cfg.talking_convergence, self.cfg.talking_proximity
        for i in range(len(infos)):
            for j in range(i + 1, len(infos)):
                a, b = infos[i], infos[j]
                if a["yaw"] is None or b["yaw"] is None:
                    continue
                left, right = (a, b) if a["cx"] <= b["cx"] else (b, a)
                if not (left["yaw"] >= conv and right["yaw"] <= -conv):
                    continue
                avg_w = (a["w"] + b["w"]) / 2 or 1.0
                dist = ((a["cx"] - b["cx"]) ** 2 + (a["cy"] - b["cy"]) ** 2) ** 0.5
                if dist <= prox * avg_w:
                    pairs.append(tuple(sorted((a["id"], b["id"]))))
        return pairs

    def analyze(self, frame, phone_boxes, now: float) -> list[dict]:
        res = self.pose.predict(frame, device=self.device, imgsz=self.cfg.imgsz,
                                 conf=self.cfg.conf, verbose=False)[0]
        boxes = res.boxes.xyxy.tolist() if res.boxes is not None else []
        kdata = res.keypoints.data.tolist() if res.keypoints is not None else []
        ids = self.tracker.update(boxes)

        # Pass 1: posture-based base state (+ yaw only for the talking check).
        infos = []
        for box, kpts, tid in zip(boxes, kdata, ids):
            yaw, _ = head_yaw(kpts, self.cfg.kpt_conf)
            base, feats = self._base_state(box, kpts, phone_boxes)
            infos.append({
                "id": tid, "box": box, "yaw": yaw, "base": base, "posture": feats,
                "cx": (box[0] + box[2]) / 2, "cy": (box[1] + box[3]) / 2,
                "w": box[2] - box[0],
            })

        # Pass 2: pairwise talking (skips anyone on a phone).
        pairs, partners = [], {}
        if self.cfg.talking_enabled:
            pairs = self._talking_pairs([i for i in infos if i["base"] != ON_PHONE])
            for a, b in pairs:
                partners.setdefault(a, []).append(b)
                partners.setdefault(b, []).append(a)

        # Pass 3: finalize + temporal smoothing.
        people, alive = [], set()
        for info in infos:
            tid = info["id"]
            alive.add(tid)
            talking_with = sorted(partners.get(tid, []))
            instant = TALKING if talking_with else info["base"]
            st = self._states.setdefault(tid, _PersonState())
            state = st.update(instant, now, self.cfg.hold_seconds)
            people.append({
                "id": tid,
                "box": [int(v) for v in info["box"]],
                "state": state,
                "instant": instant,
                "posture": info["posture"],
                "talking_with": talking_with,
            })

        for tid in list(self._states):
            if tid not in alive:
                self._states.pop(tid, None)
        return people

    @staticmethod
    def counts(people: list[dict]) -> dict:
        c = {WORKING: 0, NOT_WORKING: 0, ON_PHONE: 0, TALKING: 0}
        for p in people:
            if p["state"] in c:
                c[p["state"]] += 1
        return c

    @staticmethod
    def conversations(people: list[dict]) -> list[list[int]]:
        seen = set()
        for p in people:
            for other in p.get("talking_with", []):
                seen.add(tuple(sorted((p["id"], other))))
        return [list(pair) for pair in sorted(seen)]
