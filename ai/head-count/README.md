# Head Count

Real-time, multi-stream **head counting** over a REST API with a live dashboard.
Pure head detection + counting — no phone/pose/activity (that's the separate
`activity-monitor` project). Headless, self-healing, edge-friendly.

## Layout
```
head-count/
├── pyproject.toml          # packaging, deps, console script, tooling
├── Makefile                # install / test / run shortcuts
├── config/config.yaml      # detectors + streams + settings
├── src/headcount/          # the package (src layout)
│   ├── __main__.py         #   python -m headcount / `headcount` entrypoint
│   ├── api.py config.py counter.py manager.py model.py stream_worker.py
│   └── web/                #   dashboard (served as static files)
├── scripts/preview.py      # local GUI preview window (dev)
├── models/abel/best.pt     # head model (auto-downloads if missing)
├── deploy/headcount.service # systemd unit
└── tests/
```

## Install
```bash
python3 -m venv venv && source venv/bin/activate   # or reuse a shared venv
pip install -e .            # runtime deps + `headcount` console script
# dev extras (tests) + local GUI preview:
pip install -e ".[dev,preview]"
```
> **Jetson/Pi:** install the vendor PyTorch wheel **first**, then `pip install -e .`.

## Configure — `config/config.yaml`
```yaml
streams:
  - id: lobby
    source: "rtsp://user:pass@192.168.1.50:554/stream1"
  - id: door
    source: 0            # webcam
```
Any field is env-overridable: `HEADCOUNT_API__PORT=9000`, etc. (see `.env.example`).

## Run
```bash
headcount --config config/config.yaml     # console script
# or:  python -m headcount --config config/config.yaml
# or:  make run
```
Dashboard: **http://localhost:8000/**

## REST API
| Endpoint | Returns |
|----------|---------|
| `GET /count` | `{counts: {id: {heads: n}}, totals, streams_online, streams_total}` |
| `GET /streams` · `GET /count/{id}` | per-stream snapshot |
| `GET /video/{id}` · `GET /snapshot/{id}` | live MJPEG · single JPEG |
| `GET /health` | status, device, uptime |

## Test / deploy
```bash
make test                                  # pytest
sudo cp deploy/headcount.service /etc/systemd/system/   # edge (see file header)
```

## Local preview (dev)
```bash
python scripts/preview.py                  # needs the `preview` extra (GUI OpenCV)
```
