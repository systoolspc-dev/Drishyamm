from __future__ import annotations

import heapq

import numpy as np


class TrackEmbeddingPool:
    """Per-track top-K quality-weighted embedding pool.

    Why this matters: single-frame matching is the dominant noise source on
    real CCTV. Even a great recognizer (AdaFace, ArcFace) can miss a known
    face on 30-50% of frames due to motion blur, partial occlusion, off-angle
    pose, or compression artifacts. Aggregating the K *highest-quality* crops
    seen for a single tracked identity, then matching against the pooled
    embedding, recovers most of those misses.

    This is the simplest, most-effective form of multi-frame fusion. The
    AdaFace paper, IJB-C "frame-aggregation" protocol, and every commercial
    VMS use a variant of this pattern.

    Pool maintenance:
      - Min-heap on `quality_score`. New entries displace the worst when
        the pool is full.
      - The `(quality, counter, embedding)` tuple uses a monotonic counter
        as a tiebreaker so heap operations stay O(log K) without comparing
        ndarrays.

    Pool consumption:
      - `pooled()` returns a quality-weighted average, then re-L2-normed.
      - With cosine similarity (Qdrant default), L2-normed inputs are required;
        the average of L2-normed vectors is generally NOT unit-norm, so we
        renormalize before returning.
    """

    __slots__ = ("_top_k", "_min_quality", "_heap", "_counter")

    def __init__(self, top_k: int = 5, min_quality: float = 0.0) -> None:
        if top_k < 1:
            raise ValueError("top_k must be >= 1")
        self._top_k = top_k
        # Quality floor (roadmap A4): crops below this never pool, even into
        # empty slots. A track that only produced quality-0.2 crops publishes
        # nothing rather than a garbage pooled embedding that produces
        # confident-looking wrong matches downstream.
        self._min_quality = max(0.0, float(min_quality))
        # heap of (quality, counter, embedding); heapq is a min-heap so
        # _heap[0] is the worst-quality member of the current pool.
        self._heap: list[tuple[float, int, np.ndarray]] = []
        self._counter = 0

    @property
    def size(self) -> int:
        return len(self._heap)

    @property
    def top_k(self) -> int:
        return self._top_k

    @property
    def best_quality(self) -> float:
        return max((q for q, _, _ in self._heap), default=0.0)

    @property
    def worst_quality_in_pool(self) -> float:
        return self._heap[0][0] if self._heap else 0.0

    def would_admit(self, quality: float) -> bool:
        """Cheap pre-check that mirrors `add()`'s admission rule without
        actually inserting. Lets the orchestrator skip the expensive
        recognizer call when we already know the resulting embedding can't
        improve the pool (it would lose to the worst pool member). At steady
        state on a stable track this short-circuits 30-60% of recognizer
        calls — pure compute saving, no accuracy regression."""
        if quality < self._min_quality:
            return False
        if len(self._heap) < self._top_k:
            return True
        return quality > self._heap[0][0]

    def add(self, quality: float, embedding: np.ndarray) -> bool:
        """Add a candidate. Returns True iff the pool changed (i.e. this
        embedding either filled an empty slot or evicted a worse one).

        The caller can use the return value to decide whether to re-publish
        a match for the track. If False, the pooled embedding hasn't changed
        and there's no benefit to re-querying Qdrant."""
        emb = np.asarray(embedding, dtype=np.float32)
        if emb.ndim != 1:
            raise ValueError(f"embedding must be 1-D, got shape {emb.shape}")
        if quality < self._min_quality:
            return False
        self._counter += 1
        item = (float(quality), self._counter, emb)

        if len(self._heap) < self._top_k:
            heapq.heappush(self._heap, item)
            return True

        # heap[0] is the smallest-quality member; only displace if the new
        # one is strictly better.
        if quality <= self._heap[0][0]:
            return False
        heapq.heapreplace(self._heap, item)
        return True

    def pooled(self) -> np.ndarray | None:
        """Return the L2-normed quality-weighted-average embedding, or None
        if the pool is empty."""
        if not self._heap:
            return None
        weights = np.asarray([q for q, _, _ in self._heap], dtype=np.float32)
        embeddings = np.stack([e for _, _, e in self._heap])

        wsum = float(weights.sum())
        if wsum > 0:
            weights = weights / wsum
            pooled = (embeddings * weights[:, None]).sum(axis=0)
        else:
            pooled = embeddings.mean(axis=0)

        n = float(np.linalg.norm(pooled))
        if n <= 0:
            return None
        return (pooled / n).astype(np.float32)

    def reset(self) -> None:
        self._heap.clear()
        self._counter = 0
