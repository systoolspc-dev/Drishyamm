"""Head tracker + count state machine (v2 core).

Published count semantics change from "median of per-frame detections" to
"**number of CONFIRMED persistent tracks**" — the critique's #7-#10:

    detections → tracks → confirmed tracks → published count

Level-2 tracker (critique's ladder): constant-velocity centroid prediction +
IoU/centroid association. Deliberately ~150 lines, CPU cost ≈ microseconds.

Track lifecycle (all hysteresis lives HERE, replacing median-of-5):
    TENTATIVE --(confirm_hits obs, or one strong-conf obs)--> CONFIRMED
    CONFIRMED --(max_miss consecutive missed inferences,
                 or miss_timeout_sec without being seen)--> EXPIRED

Two-tier confidence (critique #6): a weak detection (>= candidate_conf) must
persist to confirm; a strong one (>= strong_conf) confirms instantly. Defaults
are behaviour-preserving vs the shipped conf=0.5 floor; loosening the candidate
tier below the detector floor is an accuracy-GATED change that waits for the
labelled dataset (critique #21 — no unbenchmarked accuracy knobs).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .static_suppress import iou


@dataclass
class _Track:
    box: np.ndarray                # xyxy, float32
    born_box: np.ndarray           # where this track first appeared
    vel: np.ndarray                # dcx, dcy per second
    last_seen: float
    first_seen: float
    hits: int = 1
    misses: int = 0
    confirmed: bool = False
    max_conf: float = 0.0
    # Static-object evidence (furniture ≠ people, done SAFELY):
    #   ever_moved — the track displaced meaningfully from its birth position
    #   at some point. A person who walked in has ever_moved=True FOREVER, so
    #   sitting perfectly still can never reclassify them as furniture. Only
    #   tracks that have NEVER moved since birth are furniture-eligible.
    ever_moved: bool = False
    born_during_motion: bool = False  # arrival context — TEMPORARY protection only
    strong_hits: int = 0           # observations at strong-tier confidence
    human_evidence: bool = False   # earned permanence: displacement OR repeated
                                   # strong detections. Arrival context alone
                                   # expires — a furniture false-positive born
                                   # during someone walking past must NOT be
                                   # protected forever (review round 3).
    tid: int = 0                   # stable identity, for zone-membership state
    static: bool = False           # flagged furniture — excluded from the count
    last_activity: float = 0.0     # last region micro-motion / displacement /
                                   # strong hit — the stillness clock base

    def predicted(self, now: float) -> np.ndarray:
        """Constant-velocity prediction of the box at time `now`."""
        dt = min(max(now - self.last_seen, 0.0), 1.5)   # cap extrapolation
        shift = self.vel * dt
        out = self.box.copy()
        out[0] += shift[0]; out[2] += shift[0]
        out[1] += shift[1]; out[3] += shift[1]
        return out

    def displacement_ratio(self) -> float:
        """Center displacement from birth, in units of birth-box diagonal."""
        bcx, bcy = (self.born_box[0] + self.born_box[2]) / 2, (self.born_box[1] + self.born_box[3]) / 2
        ccx, ccy = (self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2
        diag = float(np.hypot(self.born_box[2] - self.born_box[0],
                              self.born_box[3] - self.born_box[1]))
        return float(np.hypot(ccx - bcx, ccy - bcy)) / max(diag, 1.0)


@dataclass
class HeadTracker:
    iou_thr: float = 0.3            # association gate on predicted box
    centroid_frac: float = 0.8      # fallback gate: dist < frac * box diagonal
    area_ratio_gate: float = 4.0    # reject matches with >4x / <0.25x area change
    candidate_conf: float = 0.5     # weak tier — must persist to confirm
    strong_conf: float = 0.65       # strong tier — confirms instantly
    confirm_hits: int = 2           # observations for a weak track to confirm
    min_confirm_sep_sec: float = 0.3  # 2 hits within a burst must NOT confirm
    max_miss: int = 2               # consecutive missed inferences → expire…
    coast_min_sec: float = 0.8      # …but only after this much wall-clock coasting
    miss_timeout_sec: float = 6.0   # hard cap on coasting either way
    # Furniture flagging — only for tracks without human evidence.
    static_min_hits: int = 8
    static_min_span_sec: float = 120.0
    move_release_ratio: float = 0.35  # displacement (in birth-diagonals) = "moved"
    # Arrival (motion-born) protection window: long enough for a seated person
    # to accrue strong-conf evidence, short enough that a furniture FP born
    # during a busy scene eventually becomes furniture-eligible again.
    arrival_protection_sec: float = 300.0
    strong_evidence_hits: int = 3   # this many strong-tier obs = human, permanently
    tracks: list[_Track] = field(default_factory=list)
    last_keep: list[bool] = field(default_factory=list)  # per-detection: counted?
    # Counting zones. When configured, only tracks standing INSIDE a zone are
    # counted — so the number means "people in this room", not "people this lens
    # can see". None/empty = count everyone (opt-in, never silently zeroes a
    # working camera). See zones.py for the edge hysteresis.
    zone_counter: object | None = None
    frame_w: int = 0
    frame_h: int = 0
    _next_tid: int = 1

    def update(self, boxes: np.ndarray, confs: np.ndarray, now: float,
               in_motion: bool = False) -> int:
        """One inference's detections in → confirmed-track count out.

        `boxes`/`confs` should already be static-suppressor-filtered.
        Missed-inference bookkeeping happens here, so call this exactly once
        per inference (not per frame — the gate decides inference cadence).
        """
        # Enforce the weak tier: detections under candidate_conf never touch
        # the tracker (they can neither create nor feed tracks).
        if len(boxes):
            m = np.asarray(confs, dtype=np.float32) >= self.candidate_conf
            boxes, confs = np.asarray(boxes)[m], np.asarray(confs)[m]
        n = len(boxes)
        matched_tracks: set[int] = set()
        matched_dets: set[int] = set()
        det_track: dict[int, _Track] = {}

        def _area_ok(a: np.ndarray, b: np.ndarray) -> bool:
            # Reject physically impossible matches (a head does not 4x in area
            # between two inferences) so "closest" can never mean "arbitrary".
            aa = max((a[2] - a[0]) * (a[3] - a[1]), 1.0)
            ab = max((b[2] - b[0]) * (b[3] - b[1]), 1.0)
            r = aa / ab
            return (1.0 / self.area_ratio_gate) <= r <= self.area_ratio_gate

        # Greedy association: best IoU on predicted positions first.
        pairs: list[tuple[float, int, int]] = []
        for ti, t in enumerate(self.tracks):
            pred = t.predicted(now)
            for di in range(n):
                if _area_ok(pred, boxes[di]):
                    v = iou(pred, boxes[di])
                    if v >= self.iou_thr:
                        pairs.append((v, ti, di))
        for v, ti, di in sorted(pairs, reverse=True):
            if ti in matched_tracks or di in matched_dets:
                continue
            matched_tracks.add(ti); matched_dets.add(di)
            det_track[di] = self.tracks[ti]
            self._absorb(self.tracks[ti], boxes[di], float(confs[di]), now)

        # Centroid fallback for leftovers (fast heads whose IoU broke).
        for ti, t in enumerate(self.tracks):
            if ti in matched_tracks:
                continue
            pred = t.predicted(now)
            pcx, pcy = (pred[0] + pred[2]) / 2, (pred[1] + pred[3]) / 2
            diag = float(np.hypot(pred[2] - pred[0], pred[3] - pred[1]))
            best_di, best_d = -1, self.centroid_frac * max(diag, 1.0)
            for di in range(n):
                if di in matched_dets or not _area_ok(pred, boxes[di]):
                    continue
                b = boxes[di]
                d = float(np.hypot((b[0] + b[2]) / 2 - pcx, (b[1] + b[3]) / 2 - pcy))
                if d < best_d:
                    best_di, best_d = di, d
            if best_di >= 0:
                matched_tracks.add(ti); matched_dets.add(best_di)
                det_track[best_di] = t
                self._absorb(t, boxes[best_di], float(confs[best_di]), now)

        # Unmatched tracks missed this inference.
        for ti, t in enumerate(self.tracks):
            if ti not in matched_tracks:
                t.misses += 1

        # Unmatched detections start new tentative tracks.
        for di in range(n):
            if di in matched_dets:
                continue
            c = float(confs[di])
            b = np.asarray(boxes[di], dtype=np.float32)
            t = _Track(box=b, born_box=b.copy(), vel=np.zeros(2, dtype=np.float32),
                       last_seen=now, first_seen=now, max_conf=c,
                       born_during_motion=in_motion, last_activity=now,
                       tid=self._next_tid)
            self._next_tid += 1
            if c >= self.strong_conf:
                t.confirmed = True
            self.tracks.append(t)
            det_track[di] = t

        # Furniture flagging — ONLY for tracks that never moved since birth.
        # A confirmed track that ever displaced (someone walked in) is human
        # evidence forever; standing/sitting still can never demote them.
        for t in self.tracks:
            arrival_protected = (
                t.born_during_motion
                and (now - t.first_seen) < self.arrival_protection_sec
            )
            if (not t.human_evidence and not arrival_protected and not t.static
                    and t.hits >= self.static_min_hits
                    and (now - t.last_activity) >= self.static_min_span_sec):
                t.static = True

        # Expire: enough consecutive misses AND a real wall-clock gap (so busy
        # 10 Hz scenes don't burn occlusion tolerance 20x faster), with a hard
        # coast cap either way.
        self.tracks = [
            t for t in self.tracks
            if (now - t.last_seen) <= self.miss_timeout_sec
            and not (t.misses >= self.max_miss
                     and (now - t.last_seen) >= self.coast_min_sec)
        ]

        # Per-detection keep flags (drawn/counted?) for the preview layer.
        self.last_keep = [
            not (det_track[di].static if di in det_track else False) for di in range(n)
        ]
        return self.confirmed_count

    def _absorb(self, t: _Track, box: np.ndarray, conf: float, now: float) -> None:
        box = np.asarray(box, dtype=np.float32)
        dt = max(now - t.last_seen, 1e-3)
        ncx, ncy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        ocx, ocy = (t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2
        inst_v = np.array([(ncx - ocx) / dt, (ncy - ocy) / dt], dtype=np.float32)
        t.vel = 0.6 * t.vel + 0.4 * inst_v
        # Raw-box displacement from birth (BEFORE the EMA smooths it away):
        bcx, bcy = (t.born_box[0] + t.born_box[2]) / 2, (t.born_box[1] + t.born_box[3]) / 2
        diag = float(np.hypot(t.born_box[2] - t.born_box[0], t.born_box[3] - t.born_box[1]))
        raw_disp = float(np.hypot(ncx - bcx, ncy - bcy)) / max(diag, 1.0)
        if raw_disp >= self.move_release_ratio:
            t.ever_moved = True
            t.human_evidence = True
            t.static = False
            t.last_activity = now
        if conf >= self.strong_conf:
            t.strong_hits += 1
            t.last_activity = now
            if t.strong_hits >= self.strong_evidence_hits:
                t.human_evidence = True
                t.static = False
        t.box = 0.5 * t.box + 0.5 * box
        t.last_seen = now
        t.hits += 1
        t.misses = 0
        t.max_conf = max(t.max_conf, conf)
        # Confirm: enough observations AND a real time span (a 50 ms detector
        # burst must not confirm), or one strong-tier detection.
        if not t.confirmed:
            if conf >= self.strong_conf:
                t.confirmed = True
            elif (t.hits >= self.confirm_hits
                  and (now - t.first_seen) >= self.min_confirm_sep_sec):
                t.confirmed = True

    def note_region_activity(self, prev_gray: np.ndarray, cur_gray: np.ndarray,
                             frame_w: int, frame_h: int,
                             pixel_delta: int = 14, frac_thr: float = 0.05,
                             now: float | None = None) -> int:
        """Micro-motion inside a track's box (thumbnail-space gray diff).
        Resets that track's stillness clock and releases a static flag.
        Returns how many tracks showed activity."""
        if prev_gray is None or cur_gray is None or not self.tracks:
            return 0
        th, tw = cur_gray.shape[:2]
        sx, sy = tw / max(frame_w, 1), th / max(frame_h, 1)
        hits = 0
        for t in self.tracks:
            x1 = max(0, int(t.box[0] * sx)); y1 = max(0, int(t.box[1] * sy))
            x2 = min(tw, int(t.box[2] * sx) + 1); y2 = min(th, int(t.box[3] * sy) + 1)
            if x2 <= x1 or y2 <= y1:
                continue
            a = prev_gray[y1:y2, x1:x2].astype(np.int16)
            b = cur_gray[y1:y2, x1:x2].astype(np.int16)
            if float((np.abs(b - a) > pixel_delta).mean()) >= frac_thr:
                if now is not None:
                    t.last_activity = now
                t.static = False
                hits += 1
        return hits

    def _countable(self) -> list:
        """Confirmed, non-furniture tracks that are inside a counting zone."""
        live = [t for t in self.tracks if t.confirmed and not t.static]
        zc = self.zone_counter
        if zc is None or not getattr(zc, "active", False):
            return live
        w = self.frame_w or 1
        h = self.frame_h or 1
        now = max((t.last_seen for t in self.tracks), default=0.0)
        return [t for t in live
                if zc.evaluate(t.tid, t.box, w, h, now) is not None]

    @property
    def confirmed_count(self) -> int:
        # Furniture (static, never-moved) is excluded from the published count,
        # and so is anyone standing outside the configured counting zone.
        return len(self._countable())

    @property
    def counts_by_zone(self) -> dict:
        """Per-zone breakdown — how many people are in each named area."""
        zc = self.zone_counter
        if zc is None or not getattr(zc, "active", False):
            return {}
        w, h = self.frame_w or 1, self.frame_h or 1
        now = max((t.last_seen for t in self.tracks), default=0.0)
        out: dict = {}
        for t in self.tracks:
            if not t.confirmed or t.static:
                continue
            z = zc.evaluate(t.tid, t.box, w, h, now)
            if z:
                out[z] = out.get(z, 0) + 1
        return out

    @property
    def tentative_count(self) -> int:
        return sum(1 for t in self.tracks if not t.confirmed)

    @property
    def static_count(self) -> int:
        return sum(1 for t in self.tracks if t.static)
