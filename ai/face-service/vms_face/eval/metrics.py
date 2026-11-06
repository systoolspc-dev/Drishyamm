from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass, field

from vms_face.eval.types import ProbeOutcome


@dataclass(slots=True)
class GroupMetrics:
    """Metrics for a single group of probes (e.g. all 'indoor', or 'cam-01').

    Definitions (1:N identification protocol, NIST FRVT-style):
      - TP: true_id is enrolled, top-1 predicted_id == true_id
      - FN: true_id is enrolled, top-1 predicted_id != true_id (or no match returned)
      - FP: true_id NOT enrolled (i.e. 'unknown'), but a match was returned
      - TN: true_id NOT enrolled and no match returned

    Also tracked:
      - undetected: detector returned 0 faces (separate from a wrong match)
      - rejected_quality: quality gate rejected the face
    """

    group: str
    total: int = 0
    tp: int = 0
    fn: int = 0
    fp: int = 0
    tn: int = 0
    undetected: int = 0
    rejected_quality: int = 0
    similarities: list[float] = field(default_factory=list)
    detect_latencies_ms: list[float] = field(default_factory=list)
    match_latencies_ms: list[float] = field(default_factory=list)

    @property
    def positives(self) -> int:
        return self.tp + self.fn  # known-identity probes

    @property
    def negatives(self) -> int:
        return self.fp + self.tn  # unknown probes

    @property
    def tpr(self) -> float:
        return self.tp / self.positives if self.positives else 0.0

    @property
    def fnr(self) -> float:
        return self.fn / self.positives if self.positives else 0.0

    @property
    def fpr(self) -> float:
        return self.fp / self.negatives if self.negatives else 0.0

    @property
    def precision(self) -> float:
        denom = self.tp + self.fp
        return self.tp / denom if denom else 0.0

    @property
    def recall(self) -> float:
        return self.tpr

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return (2 * p * r / (p + r)) if (p + r) else 0.0

    @property
    def detection_rate(self) -> float:
        return 1.0 - (self.undetected / self.total) if self.total else 0.0

    def latency_summary(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for label, samples in (("detect_ms", self.detect_latencies_ms), ("match_ms", self.match_latencies_ms)):
            if not samples:
                out[f"{label}_p50"] = 0.0
                out[f"{label}_p95"] = 0.0
                out[f"{label}_p99"] = 0.0
                continue
            sorted_s = sorted(samples)
            n = len(sorted_s)
            out[f"{label}_p50"] = sorted_s[int(0.50 * (n - 1))]
            out[f"{label}_p95"] = sorted_s[int(0.95 * (n - 1))]
            out[f"{label}_p99"] = sorted_s[int(0.99 * (n - 1))]
            out[f"{label}_mean"] = statistics.mean(sorted_s)
        return out

    def to_dict(self) -> dict:
        return {
            "group": self.group,
            "total": self.total,
            "positives": self.positives,
            "negatives": self.negatives,
            "tp": self.tp,
            "fn": self.fn,
            "fp": self.fp,
            "tn": self.tn,
            "undetected": self.undetected,
            "rejected_quality": self.rejected_quality,
            "tpr_recall": round(self.tpr, 4),
            "fnr": round(self.fnr, 4),
            "fpr": round(self.fpr, 4),
            "precision": round(self.precision, 4),
            "f1": round(self.f1, 4),
            "detection_rate": round(self.detection_rate, 4),
            "mean_similarity": round(statistics.mean(self.similarities), 4) if self.similarities else 0.0,
            **{k: round(v, 3) for k, v in self.latency_summary().items()},
        }


def aggregate(outcomes: list[ProbeOutcome], *, group_keys: list[str] | None = None) -> dict[str, GroupMetrics]:
    """Aggregate ProbeOutcomes into named GroupMetrics.

    Always emits an "all" bucket. If `group_keys` is given, additionally splits
    by each tag in `outcome.tags` (e.g. ['scenario', 'camera'])."""
    buckets: dict[str, GroupMetrics] = defaultdict(lambda: GroupMetrics(group="all"))
    overall = GroupMetrics(group="all")

    for o in outcomes:
        _update(overall, o)
        if group_keys:
            for key in group_keys:
                tag = o.tags.get(key)
                if tag is None:
                    continue
                bucket_name = f"{key}={tag}"
                if bucket_name not in buckets:
                    buckets[bucket_name] = GroupMetrics(group=bucket_name)
                _update(buckets[bucket_name], o)

    buckets["all"] = overall
    return dict(buckets)


def _update(g: GroupMetrics, o: ProbeOutcome) -> None:
    g.total += 1
    if o.detect_latency_ms is not None:
        g.detect_latencies_ms.append(o.detect_latency_ms)
    if o.match_latency_ms is not None:
        g.match_latencies_ms.append(o.match_latency_ms)
    if o.similarity is not None:
        g.similarities.append(o.similarity)

    if o.undetected:
        g.undetected += 1
        # an undetected probe of a known person is a FN
        if o.true_person_id is not None:
            g.fn += 1
        else:
            g.tn += 1
        return

    if o.rejected_quality:
        g.rejected_quality += 1
        if o.true_person_id is not None:
            g.fn += 1
        else:
            g.tn += 1
        return

    is_known = o.true_person_id is not None
    matched = o.predicted_person_id is not None

    if is_known and matched and o.predicted_person_id == o.true_person_id:
        g.tp += 1
    elif is_known and not matched:
        g.fn += 1
    elif is_known and matched and o.predicted_person_id != o.true_person_id:
        g.fn += 1  # wrong identity counts as a miss for recall
    elif not is_known and matched:
        g.fp += 1
    else:
        g.tn += 1
