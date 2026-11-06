"""Per-track demographic attribute voting (gender + age).

Why this exists: buffalo_l's genderage head is a per-crop classifier. On
clean webcam-style faces it's ~95% accurate; on a real CCTV crop (small,
motion-blurred, off-axis) a single frame's output flips between Male and
Female from one frame to the next. Publishing that per-frame guess makes
the overlay flicker and makes any demographic count meaningless.

The fix is the same pattern the embedding pool uses for recognition:
aggregate across the track. Each quality-passing observation contributes a
vote weighted by its quality score (a sharp, well-lit, frontal crop counts
for more than a blurry profile). A label is asserted only once:

  1. at least `attributes_min_votes` votes have accumulated, AND
  2. one side holds >= `attributes_min_agreement` of the weighted mass.

Until then the label is None ("don't know yet") — downstream surfaces show
nothing rather than noise. Age is the quality-weighted mean of the per-crop
age regressions, which converges fast because age errors are roughly
zero-mean per crop.

Compute contract: `needs_sample()` tells the orchestrator whether spending
another genderage inference on this track is worthwhile. Sampling stops at
`attributes_max_votes`, or earlier when the vote is decisively settled — so
attribute inference is O(1) per track instead of O(frames).
"""
from __future__ import annotations

from vms_face.config import settings

# Weighted agreement above which the vote is considered decisively settled
# and further sampling is pure waste, even before max_votes is reached.
_EARLY_STOP_AGREEMENT = 0.90


class TrackAttributes:
    """Quality-weighted gender vote + age aggregate for one track.

    Not thread-safe by itself — mutated only from the orchestrator's event
    loop (same discipline as the embedding pool)."""

    __slots__ = ("_male_w", "_female_w", "_votes", "_age_wsum", "_age_w")

    def __init__(self) -> None:
        self._male_w = 0.0
        self._female_w = 0.0
        self._votes = 0
        self._age_wsum = 0.0
        self._age_w = 0.0

    @property
    def votes(self) -> int:
        return self._votes

    def add_vote(self, gender: int | None, age: float | None, weight: float) -> None:
        """Record one observation. `gender` uses the insightface convention
        (1 = male, 0 = female); `weight` is the quality-gate composite score."""
        w = max(1e-3, float(weight))
        if gender is not None:
            if int(gender) == 1:
                self._male_w += w
            else:
                self._female_w += w
            self._votes += 1
        if age is not None and age > 0:
            self._age_wsum += float(age) * w
            self._age_w += w

    def _agreement(self) -> float:
        total = self._male_w + self._female_w
        if total <= 0:
            return 0.0
        return max(self._male_w, self._female_w) / total

    def needs_sample(self) -> bool:
        """True while another genderage inference could still change or
        strengthen the outcome. The orchestrator uses this to gate the
        explicit genderage call — once False, the track never pays for
        attribute inference again."""
        if self._votes >= settings.attributes_max_votes:
            return False
        if (
            self._votes >= settings.attributes_min_votes
            and self._agreement() >= _EARLY_STOP_AGREEMENT
        ):
            return False
        return True

    def gender_label(self) -> str | None:
        """Stable label, or None while the vote is unresolved / too split.
        A permanently-split vote (e.g. 50/50 after max_votes) stays None —
        "unknown" is the correct answer for a face we can't call."""
        if self._votes < settings.attributes_min_votes:
            return None
        if self._agreement() < settings.attributes_min_agreement:
            return None
        return "Male" if self._male_w >= self._female_w else "Female"

    def gender_confidence(self) -> float | None:
        """Weighted agreement in [0.5, 1.0] once a label exists, else None."""
        if self.gender_label() is None:
            return None
        return round(self._agreement(), 3)

    def age_estimate(self) -> int | None:
        """Quality-weighted mean age, rounded. None until any age sample
        arrives. Deliberately not gated on min_votes — age is a regression
        (errors average out), not a coin-flip classification."""
        if self._age_w <= 0:
            return None
        return int(round(self._age_wsum / self._age_w))
