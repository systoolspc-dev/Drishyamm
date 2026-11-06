"""
plate_votes.py — per-track, per-CHARACTER, confidence-weighted temporal voting.

The old voter counted whole strings: a track was trusted once N frames produced
the identical read. That throws away most of the evidence — five frames that
each get 9 of 10 characters right (different one wrong each time) never agree,
yet together they spell the plate perfectly.

This voter accumulates weight per POSITION per CHARACTER across every read of a
track (all frames × all enhancement variants), then takes the column-wise
winner. Weight = OCR confidence × variant prior × detector confidence, so a
crisp read counts more than a smeared one and the raw crop counts more than a
speculative deconvolution.

Two safeguards keep it honest:
  • Reads of different lengths vote in separate buckets (a 9-char and a 10-char
    hypothesis can't smear into each other); the heaviest bucket wins.
  • Per frame, only the best read casts a full vote; the other variants of the
    same frame cast a fractional one. Variants of one frame are correlated, so
    this keeps "frames that agree" — the thing an officer intuitively trusts —
    as the unit of evidence, and MIN_VOTES keeps its meaning.

Output is a Consensus with an AGREEMENT ratio (mean over positions of the
winner's share of the weight). The worker requires both enough frames and
enough agreement before it posts — that's R4 (calibrated confidence) — and
the string it posts is the column-wise consensus, not any single frame's read
— that's R5 (temporal stitching).

Two additions from the 2026-09-02 audit (120 posted + 48 rejected reads
labelled by hand from the crops):
  • RAW PRESERVATION. The votes are cast with the RULE-CORRECTED text, so the
    heaviest whole-string vote is not what the OCR actually output. A second
    tally keeps the uncorrected greedy reads; Consensus.raw_text is the
    heaviest of those. Validation must never silently rewrite the OCR output —
    the raw read and the normalised read are both stored.
  • LENGTH AMBIGUITY. The per-length buckets let a 9-char bucket win on total
    weight when the OCR dropped ONE character on a ~7 px/char crop — far more
    often than Gujarat issues single-letter-series plates. 6 wrong 9-char
    reads each had, among the alternatives, a VALID 10-char read equal to the
    consensus with exactly one character inserted (after look-alike
    normalisation); switching fixed all 6 and broke 0 correct reads.
    Consensus.longer exposes that read; the worker decides whether to switch.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

from plate_rules import is_valid_plate

# Look-alike glyph classes for the superstring test. These are the confusions
# the OCR makes on small crops (the same pairs plate_rules' TO_DIGIT /
# TO_LETTER fix by position); two strings that differ only inside a class are
# the same read. Each character maps to its class representative.
_LOOKALIKE: dict[str, str] = {}
for _grp in ("0OQD", "1IL", "2Z", "5S", "8B", "6GCE", "4A", "7T"):
    for _ch in _grp:
        _LOOKALIKE[_ch] = _grp[0]


def lookalike_norm(s: str) -> str:
    """Collapse look-alike glyphs to one representative per class
    (O/Q/D→0, I/L→1, Z→2, S→5, B→8, G/C/E→6, A→4, T→7)."""
    return "".join(_LOOKALIKE.get(c, c) for c in str(s or "").upper())


def one_insertion(short: str, long: str) -> bool:
    """True when `long` is `short` with exactly ONE character inserted, after
    look-alike normalisation of both — i.e. deleting one character of `long`
    yields `short`. GJ11C1758 vs GJ11CL7580 → True (the OCR dropped the L and
    the trailing 0 became the last slot); GJ08F1957 vs GJ08FA9678 → False (a
    shifted read, several characters differ)."""
    a, b = lookalike_norm(short), lookalike_norm(long)
    if not a or len(b) != len(a) + 1:
        return False
    i = j = 0
    skipped = False
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        if skipped:
            return False
        skipped = True  # the one inserted character
        j += 1
    return i == len(a)


@dataclass
class Read:
    text: str  # cleaned A-Z0-9
    probs: list[float] | None  # per-character confidence, aligned to text
    weight: float  # overall trust in this read
    variant: str = "base"
    valid: bool = False  # passed plate_rules
    corrected: str | None = None  # rule-corrected text (may differ from text)

    @property
    def conf(self) -> float:
        if self.probs:
            return float(np.mean(self.probs))
        return 0.0

    @property
    def vote_text(self) -> str:
        return self.corrected or self.text


@dataclass
class Consensus:
    text: str
    agreement: float  # 0..1, mean winner share per position
    weight: float  # total weight in the winning length bucket
    n_frames: int  # frames that contributed any read
    mean_conf: float  # mean OCR confidence of the primary reads
    top_whole: tuple[str, float]  # heaviest single whole-string read
    alternatives: list[tuple[str, float]] = field(default_factory=list)
    # heaviest UNCORRECTED (greedy) read and the next three — what the OCR
    # actually output, before any rule touched it ('' when nothing was read)
    raw_text: str = ""
    raw_alternatives: list[tuple[str, float]] = field(default_factory=list)
    # heaviest VALID whole-string read one character longer than `text` that
    # is `text` with one insertion (one_insertion) — the length-ambiguity
    # candidate. None when there is none. The worker applies the switch
    # (ANPR_LEN_SWITCH), this only reports it.
    longer: tuple[str, float] | None = None

    def confidence(self, min_votes: int) -> float:
        """Calibrated-ish 0..1: agreement × OCR confidence × evidence volume."""
        vol = min(1.0, self.n_frames / max(1, min_votes))
        return float(np.clip(self.agreement * max(self.mean_conf, 0.05) ** 0.5 * vol, 0.0, 1.0))


class TrackVotes:
    SECONDARY_SHARE = 0.25  # fractional vote for non-best variants of a frame
    MAX_SECONDARY = 3

    def __init__(self) -> None:
        self._by_len: dict[int, dict] = {}
        self._whole: Counter = Counter()
        self._whole_raw: Counter = Counter()  # uncorrected greedy text, same weights as _whole
        self._frames: set[int] = set()
        self._conf_sum = 0.0
        self._conf_n = 0
        self.reads: int = 0
        self.last_frame: int = -1

    # ── input ────────────────────────────────────────────────────────────
    def add_frame(self, frame_idx: int, reads: list[Read]) -> Read | None:
        """Tally every read from ONE frame. Returns the primary (best) read."""
        reads = [r for r in reads if r and r.vote_text]
        if not reads:
            return None
        # valid reads first, then heavier ones
        reads.sort(key=lambda r: (r.valid, r.weight), reverse=True)
        primary = reads[0]
        self._tally(primary, primary.weight)
        self._conf_sum += primary.conf
        self._conf_n += 1
        n = 0
        for r in reads[1:]:
            if r.vote_text == primary.vote_text:
                continue
            self._tally(r, r.weight * self.SECONDARY_SHARE)
            n += 1
            if n >= self.MAX_SECONDARY:
                break
        self._frames.add(frame_idx)
        self.last_frame = max(self.last_frame, frame_idx)
        return primary

    def _tally(self, r: Read, w: float) -> None:
        text = r.vote_text
        b = self._by_len.setdefault(len(text), {"pos": defaultdict(Counter), "w": 0.0, "n": 0})
        b["w"] += w
        b["n"] += 1
        probs = r.probs if r.probs and len(r.probs) >= len(text) else None
        for i, ch in enumerate(text):
            p = probs[i] if probs else 1.0
            b["pos"][i][ch] += w * max(0.05, float(p))
        self._whole[text] += w
        if r.text:
            self._whole_raw[r.text] += w  # the OCR's own output, untouched by the rules
        self.reads += 1

    # ── output ───────────────────────────────────────────────────────────
    @property
    def n_frames(self) -> int:
        return len(self._frames)

    def _longer_read(self, text: str) -> tuple[str, float] | None:
        """Heaviest VALID whole-string read of length len(text)+1 that is
        `text` with one character inserted (look-alike aware) — from ANY
        length bucket, i.e. the read the bucket rule out-voted."""
        want = len(text) + 1
        for s, w in self._whole.most_common():
            if len(s) != want:
                continue
            if is_valid_plate(s) and one_insertion(text, s):
                return (s, round(float(w), 3))
        return None

    def consensus(self) -> Consensus | None:
        if not self._by_len:
            return None
        length, b = max(self._by_len.items(), key=lambda kv: kv[1]["w"])
        chars, shares = [], []
        for i in range(length):
            col = b["pos"][i]
            tot = sum(col.values())
            if not col or tot <= 0:
                chars.append("?")
                shares.append(0.0)
                continue
            ch, wt = col.most_common(1)[0]
            chars.append(ch)
            shares.append(wt / tot)
        text = "".join(chars)
        top_whole = self._whole.most_common(1)[0]
        alts = [(t, round(w, 3)) for t, w in self._whole.most_common(4) if t != text]
        raw_top = self._whole_raw.most_common(1)[0][0] if self._whole_raw else ""
        raw_alts = [(t, round(float(w), 3)) for t, w in self._whole_raw.most_common(4) if t != raw_top][:3]
        return Consensus(
            text=text,
            agreement=float(np.mean(shares)) if shares else 0.0,
            weight=float(b["w"]),
            n_frames=self.n_frames,
            mean_conf=(self._conf_sum / self._conf_n) if self._conf_n else 0.0,
            top_whole=(top_whole[0], round(float(top_whole[1]), 3)),
            alternatives=alts,
            raw_text=raw_top,
            raw_alternatives=raw_alts,
            longer=self._longer_read(text),
        )

    def summary(self) -> dict:
        c = self.consensus()
        return {
            "frames": self.n_frames,
            "reads": self.reads,
            "consensus": c.text if c else None,
            "agreement": round(c.agreement, 3) if c else None,
            "top": [(t, round(float(w), 2)) for t, w in self._whole.most_common(5)],
            "raw": c.raw_text if c else None,
            "raw_top": [(t, round(float(w), 2)) for t, w in self._whole_raw.most_common(3)],
            "longer": c.longer if c else None,
        }


if __name__ == "__main__":
    # Five noisy frames, each with one different wrong character → the
    # column vote recovers the plate no single frame got right.
    truth = "GJ01AB1234"
    frames = ["GJ01AB1Z34", "GJ0IAB1234", "GJ01A81234", "GJ01AB12S4", "CJ01AB1234"]
    tv = TrackVotes()
    for i, t in enumerate(frames):
        probs = [0.9] * len(t)
        tv.add_frame(i, [Read(t, probs, 0.9, "base")])
    c = tv.consensus()
    print(c.text, "agreement=%.2f" % c.agreement, "frames=%d" % c.n_frames, "conf=%.2f" % c.confidence(3))
    assert c.text == truth, c.text
    # raw preservation: the vote uses the corrected text, the raw tally does not
    tv = TrackVotes()
    tv.add_frame(0, [Read("GJ01AB1Z34", [0.9] * 10, 0.9, "base", valid=True, corrected="GJ01AB1234")])
    c = tv.consensus()
    assert c.text == "GJ01AB1234" and c.raw_text == "GJ01AB1Z34", (c.text, c.raw_text)
    # superstring rule (audit 2026-09-02): the six measured pairs, one shifted read
    for s, l_ in (
        ("GJ11C1758", "GJ11CL7580"),
        ("GJ27E6741", "GJ27EC7416"),
        ("GJ01R5592", "GJ01RS5926"),
        ("GJ24A4516", "GJ24AA5169"),
        ("GJ18B8744", "GJ18BB7442"),
        ("GJ18E4884", "GJ18EA8844"),
    ):
        assert one_insertion(s, l_), (s, l_)
    assert not one_insertion("GJ08F1957", "GJ08FA9678")
    tv = TrackVotes()
    for i in range(3):
        tv.add_frame(i, [Read("GJ11C1758", [0.9] * 9, 0.8, "base", valid=True, corrected="GJ11C1758")])
    tv.add_frame(3, [Read("GJ11CL7580", [0.9] * 10, 0.43, "base", valid=True, corrected="GJ11CL7580")])
    c = tv.consensus()
    assert c.text == "GJ11C1758" and c.longer == ("GJ11CL7580", 0.43), (c.text, c.longer)
    print("plate_votes OK")
