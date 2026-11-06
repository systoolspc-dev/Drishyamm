"""Identity latch — the L0 recognition cache, keyed on the track.

Why this exists
---------------
Before this, the orchestrator published a FaceCandidate on EVERY change to a
track's embedding pool once the track had `track_min_hits_to_match` hits. The
pool changes on every warm-up embed and on every better crop, so one person
standing in view for 30 s produced dozens of candidates — each a 1:N query, a
DetectionEvent row and an alert message — for an identity that was decided in
the first second. Unknown visitors were worse: every candidate re-ran the full
gallery search to be told "no" again.

The latch makes the TRACK the unit of recognition work:

    NEW ──(first eligible pool change)──▶ CANDIDATE ──(K-of-N agree)──▶ LATCHED
     │                                        │                            │
     │                                        └──(N queries, no hit)──▶ UNKNOWN
     │                                                                     │
     └─────────────────────────────── re-verify on: quality jump / timer / ─┘
                                      tracker uncertainty; N disagreements
                                      in a row ⇒ back to CANDIDATE

Two gates the orchestrator consults, in order:

  * `should_embed()`  — before spending the recognizer. A LATCHED or UNKNOWN
    track only embeds when a re-verify is due.
  * `should_publish()` — after the pool updated. Decides whether this pooled
    template goes to the match worker at all.

And one input: `apply_verdict()`, fed from the match worker's answer over the
`vms.verdict` channel. The latch never talks to Redis or Qdrant itself — it is
pure state, so it is unit-testable and trivially portable to the edge runtime.

Publish early, correct later: the first hit is exposed to the overlay as a
PROVISIONAL identity (`display()` returns state="provisional"); the Kth
agreeing hit makes it CONFIRMED. Alerts key on confirmed transitions only —
see docs/DETECTION_DECISION_ALERT_FRAMEWORK.md.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from vms_face.config import settings


class LatchState(str, Enum):
    NEW = "new"
    CANDIDATE = "candidate"
    LATCHED = "latched"
    UNKNOWN = "unknown"


@dataclass(slots=True)
class Verdict:
    """One match-worker answer for this track."""

    person_id: str | None
    name: str | None
    similarity: float
    ambiguous: bool = False
    at: float = 0.0


@dataclass(slots=True)
class Decision:
    ok: bool            # True = spend the recognizer / send the candidate
    reason: str


@dataclass(slots=True)
class Display:
    name: str
    state: str                 # "unknown" | "provisional" | "confirmed"
    person_id: str | None
    confidence: float | None


@dataclass(slots=True)
class LatchConfig:
    confirm_k: int = 2
    confirm_n: int = 3
    candidate_gap_sec: float = 0.5
    reverify_sec: float = 12.0
    quality_jump: float = 0.10
    unlatch_after: int = 3
    max_unknown_queries: int = 3
    unknown_retry_sec: float = 20.0

    @classmethod
    def from_settings(cls) -> "LatchConfig":
        return cls(
            confirm_k=max(1, int(settings.identity_latch_confirm_k)),
            confirm_n=max(1, int(settings.identity_latch_confirm_n)),
            candidate_gap_sec=max(0.0, float(settings.identity_latch_candidate_gap_sec)),
            reverify_sec=max(0.5, float(settings.identity_latch_reverify_sec)),
            quality_jump=max(0.0, float(settings.identity_latch_quality_jump)),
            unlatch_after=max(1, int(settings.identity_latch_unlatch_after)),
            max_unknown_queries=max(1, int(settings.identity_latch_max_unknown_queries)),
            unknown_retry_sec=max(0.5, float(settings.identity_latch_unknown_retry_sec)),
        )


def _default_config() -> LatchConfig:
    return LatchConfig.from_settings()


@dataclass(slots=True)
class IdentityLatch:
    """Per-track identity state. Pure logic — no I/O, no clock of its own
    (every method takes `now` so tests are deterministic)."""

    config: LatchConfig = field(default_factory=_default_config)
    state: LatchState = LatchState.NEW

    # Confirmed identity (LATCHED) or provisional identity (CANDIDATE).
    person_id: str | None = None
    name: str | None = None
    confidence: float = 0.0
    provisional: bool = False

    # Bookkeeping.
    first_seen_at: float = 0.0        # first quality-passing face (TTI origin)
    provisional_at: float = 0.0
    latched_at: float = 0.0
    last_query_at: float = 0.0
    last_verified_at: float = 0.0
    quality_at_last_query: float = 0.0
    queries_total: int = 0
    unknown_queries: int = 0
    disagreements: int = 0
    transitions: int = 0
    # Set by the orchestrator when the tracker became uncertain about this
    # track (misses, re-association) — forces one re-verify.
    uncertain: bool = False
    votes: deque = field(default_factory=lambda: deque(maxlen=3))

    def __post_init__(self) -> None:
        self.votes = deque(maxlen=self.config.confirm_n)

    # ── time-to-identity origin ────────────────────────────────────────────

    def note_face(self, now: float) -> None:
        if self.first_seen_at <= 0:
            self.first_seen_at = now

    # ── gate 1: should we spend the recognizer? ─────────────────────────────

    def _reverify_due(self, now: float, quality: float) -> str | None:
        """Reason string when a LATCHED/UNKNOWN track should be looked at again."""
        if self.uncertain:
            return "uncertain"
        if quality >= self.quality_at_last_query + self.config.quality_jump:
            return "quality_jump"
        if self.state is LatchState.LATCHED:
            if now - self.last_verified_at >= self.config.reverify_sec:
                return "reverify_timer"
        elif self.state is LatchState.UNKNOWN:
            if now - self.last_query_at >= self.config.unknown_retry_sec:
                return "unknown_retry"
        return None

    def should_embed(self, now: float, quality: float) -> Decision:
        if self.state in (LatchState.NEW, LatchState.CANDIDATE):
            return Decision(True, "converging")
        reason = self._reverify_due(now, quality)
        if reason is not None:
            return Decision(True, reason)
        return Decision(False, "identity_latched" if self.state is LatchState.LATCHED else "unknown_latched")

    # ── gate 2: should this pooled template go to the match worker? ─────────

    def should_publish(
        self,
        now: float,
        *,
        pool_changed: bool,
        quality: float,
        hits: int,
        min_hits: int,
    ) -> Decision:
        if hits < min_hits:
            return Decision(False, "immature")
        if self.state is LatchState.NEW:
            if pool_changed:
                return Decision(True, "first_template")
            return Decision(False, "no_template")
        if self.state is LatchState.CANDIDATE:
            if not pool_changed and not self.uncertain:
                return Decision(False, "pool_unchanged")
            if now - self.last_query_at < self.config.candidate_gap_sec:
                return Decision(False, "candidate_gap")
            return Decision(True, "candidate")
        # LATCHED / UNKNOWN: only when a re-verify is due. We got here because
        # should_embed() said yes for the same reason, so this is normally True.
        reason = self._reverify_due(now, quality)
        if reason is None:
            return Decision(False, "identity_latched" if self.state is LatchState.LATCHED else "unknown_latched")
        if self.state is LatchState.UNKNOWN and reason == "unknown_retry":
            # Retry budget: a retry is a full 1:N miss in the common case.
            self.unknown_queries = 0
        return Decision(True, reason)

    def note_published(self, now: float, quality: float) -> None:
        self.last_query_at = now
        self.quality_at_last_query = max(self.quality_at_last_query, quality) if self.state in (
            LatchState.LATCHED, LatchState.UNKNOWN
        ) else quality
        self.queries_total += 1
        self.uncertain = False
        if self.state is LatchState.NEW:
            self._transition(LatchState.CANDIDATE)

    # ── input: the match worker's answer ───────────────────────────────────

    def apply_verdict(self, v: Verdict, now: float) -> tuple[LatchState, LatchState, str]:
        """Returns (from_state, to_state, reason). from == to when nothing
        changed. Reasons are stable strings for metrics."""
        before = self.state
        self.votes.append(v)
        hit = v.person_id is not None and not v.ambiguous

        if hit:
            self.unknown_queries = 0
            agreeing = sum(1 for x in self.votes if x.person_id == v.person_id and not x.ambiguous)
            if self.state is LatchState.LATCHED:
                if v.person_id == self.person_id:
                    self.disagreements = 0
                    self.last_verified_at = now
                    self.confidence = float(v.similarity)
                    if v.name:
                        self.name = v.name
                    return before, self.state, "reverified"
                # A different person on a track we thought we knew.
                self.disagreements += 1
                if agreeing >= self.config.confirm_k or self.disagreements >= self.config.unlatch_after:
                    self._set_identity(v, provisional=agreeing < self.config.confirm_k, now=now)
                    self.transitions += 1
                    self._transition(LatchState.LATCHED if not self.provisional else LatchState.CANDIDATE)
                    return before, self.state, "identity_change"
                return before, self.state, "disagreement_held"

            # NEW / CANDIDATE / UNKNOWN with a hit.
            if agreeing >= self.config.confirm_k:
                self._set_identity(v, provisional=False, now=now)
                self._transition(LatchState.LATCHED)
                return before, self.state, "confirmed"
            self._set_identity(v, provisional=True, now=now)
            self._transition(LatchState.CANDIDATE)
            return before, self.state, "provisional"

        # Miss or ambiguous.
        if self.state is LatchState.LATCHED:
            self.disagreements += 1
            if self.disagreements >= self.config.unlatch_after:
                self._clear_identity()
                self._transition(LatchState.CANDIDATE)
                return before, self.state, "unlatched"
            return before, self.state, "miss_held"
        if self.state is LatchState.UNKNOWN:
            self.last_query_at = now
            return before, self.state, "still_unknown"
        # NEW / CANDIDATE
        self.unknown_queries += 1
        if self.provisional and v.ambiguous:
            # Keep a provisional name through an ambiguous frame; drop it on a
            # clean miss so we don't show a name the gallery no longer backs.
            return before, self.state, "ambiguous_held"
        if self.provisional:
            self._clear_identity()
        if self.unknown_queries >= self.config.max_unknown_queries:
            self._transition(LatchState.UNKNOWN)
            return before, self.state, "negative_latch"
        return before, self.state, "miss"

    # ── output: what the overlay should draw ───────────────────────────────

    def display(self) -> Display:
        if self.state is LatchState.LATCHED and self.person_id:
            return Display(self.name or "Known", "confirmed", self.person_id, self.confidence)
        if self.provisional and self.person_id:
            return Display(self.name or "Known", "provisional", self.person_id, self.confidence)
        return Display("Unknown", "unknown", None, None)

    def adopt(self, person_id: str, name: str | None, confidence: float, now: float) -> None:
        """Inherit an identity from a recently-dead track (re-association).
        Provisional — one agreeing verdict confirms it."""
        self.person_id = person_id
        self.name = name
        self.confidence = float(confidence)
        self.provisional = True
        self.provisional_at = now
        self.votes.append(Verdict(person_id, name, confidence, False, now))
        self.uncertain = True   # force one verify soon
        self._transition(LatchState.CANDIDATE)

    def snapshot(self) -> dict:
        """Cheap diagnostic view for /streams/debug and the candidate payload."""
        return {
            "state": self.state.value,
            "person_id": self.person_id,
            "provisional": self.provisional,
            "confidence": round(self.confidence, 4),
            "queries": self.queries_total,
            "transitions": self.transitions,
        }

    # ── internals ──────────────────────────────────────────────────────────

    def _set_identity(self, v: Verdict, *, provisional: bool, now: float) -> None:
        was_named = self.person_id == v.person_id
        self.person_id = v.person_id
        self.name = v.name or self.name
        self.confidence = float(v.similarity)
        self.provisional = provisional
        self.disagreements = 0
        if provisional and (not was_named or self.provisional_at <= 0):
            self.provisional_at = now
        if not provisional:
            if self.provisional_at <= 0:
                self.provisional_at = now
            self.latched_at = now
            self.last_verified_at = now

    def _clear_identity(self) -> None:
        self.person_id = None
        self.name = None
        self.confidence = 0.0
        self.provisional = False
        self.disagreements = 0
        self.latched_at = 0.0

    def _transition(self, to: LatchState) -> None:
        self.state = to


# ── Re-association bank ───────────────────────────────────────────────────


@dataclass(slots=True)
class _DeadIdentity:
    template: np.ndarray
    person_id: str
    name: str | None
    confidence: float
    died_at: float


class RecentIdentityBank:
    """Identities of tracks that died recently, with their pooled templates.

    When a person is occluded for a second the tracker drops the track and
    births a new one; without this the box goes back to "Unknown" and the
    whole confirm dance restarts. A new track whose first template is close
    enough to a recently-dead one inherits its identity as PROVISIONAL.

    Bounded by time (`ttl_sec`) and size; matching is a single matmul."""

    def __init__(self, *, ttl_sec: float, min_cosine: float, max_items: int = 64) -> None:
        self._ttl = max(1.0, float(ttl_sec))
        self._min_cos = float(min_cosine)
        self._max = max(1, int(max_items))
        self._items: list[_DeadIdentity] = []

    def __len__(self) -> int:
        return len(self._items)

    def remember(self, latch: IdentityLatch, template: np.ndarray | None, now: float) -> None:
        if template is None or latch.state is not LatchState.LATCHED or not latch.person_id:
            return
        t = np.asarray(template, dtype=np.float32).reshape(-1)
        n = float(np.linalg.norm(t))
        if n <= 0:
            return
        self._prune(now)
        self._items.append(_DeadIdentity(t / n, latch.person_id, latch.name, latch.confidence, now))
        if len(self._items) > self._max:
            del self._items[: len(self._items) - self._max]

    def claim(self, template: np.ndarray, now: float) -> _DeadIdentity | None:
        """Best recently-dead identity for this template, or None. The winner
        is removed so two new tracks cannot both claim the same dead one."""
        self._prune(now)
        if not self._items:
            return None
        t = np.asarray(template, dtype=np.float32).reshape(-1)
        n = float(np.linalg.norm(t))
        if n <= 0:
            return None
        t = t / n
        mat = np.stack([d.template for d in self._items])
        sims = mat @ t
        i = int(np.argmax(sims))
        if float(sims[i]) < self._min_cos:
            return None
        return self._items.pop(i)

    def _prune(self, now: float) -> None:
        cutoff = now - self._ttl
        if self._items and self._items[0].died_at < cutoff:
            self._items = [d for d in self._items if d.died_at >= cutoff]


def monotonic() -> float:
    return time.monotonic()
