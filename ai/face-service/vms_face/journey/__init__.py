"""Journey reconstruction module — centralized into smart-cam-ai.

Absorbs the former standalone `person-tracker` service (upload a face → find
every camera + timestamp → stitched MP4 + PDF + map) and grafts journey-platform's
face+body fusion on top. Embedding is in-process (no HTTP hop) and persistence
lands in this service's Postgres (`journeys`/`journey_stops`/`embeddings`) + Qdrant
(`vms_appearance` face, `body_reid` body). See docs/JOURNEY_CENTRALIZATION.md.

Slices:
  contracts  — REST/wire shapes
  window     — time-window parsing
  embed      — in-process face (+ body, P1b) query embedding
  search     — Qdrant appearance ANN query
  cluster    — collapse candidates into per-camera sightings
"""
