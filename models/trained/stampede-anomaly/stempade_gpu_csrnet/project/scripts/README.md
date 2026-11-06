# Scripts

| Script | Runs on | Purpose |
|--------|---------|---------|
| `simulate_crowd.py`  | CPU | Generate labeled synthetic normal→panic clips (social-force model) |
| `make_homography.py` | CPU | Build a per-camera pixel→meter homography from ≥4 points |
| `train_fusion.py`    | CPU | Train the learned fusion model (logistic regression) from labeled videos |
| `train_csrnet.py`    | **GPU** | Train/fine-tune CSRNet density on ShanghaiTech — **heavy, run on the GPU box** |

## Typical workflow

```bash
# 1. make a labeled synthetic clip to develop/test against
python scripts/simulate_crowd.py --n 150 --seconds 30 --panic-at 15 --out data/samples/sim

# 2. learn this camera's "normal" from a normal segment
stempade calibrate data/samples/sim.mp4 --out baseline.json --max-frames 200

# 3. run detection / evaluate
stempade run  data/samples/sim.mp4 --baseline baseline.json
stempade eval data/samples/sim.mp4 data/samples/sim.labels.txt --baseline baseline.json

# 4. (optional) train learned fusion, then set fusion.learned_model in the config
python scripts/train_fusion.py --pair data/samples/sim.mp4 data/samples/sim.labels.txt \
    --baseline baseline.json --out weights/fusion_lr.joblib

# 5. serve live RTSP + dashboard  (pip install -e ".[serving]")
stempade serve --port 8000
```

## GPU (density) — run on the machine with the GPU

```bash
pip install -e ".[density]"
python scripts/train_csrnet.py --data data/shanghaitech/part_A --epochs 100 \
    --out weights/csrnet_shanghaitech.pth
# then set density.enabled: true and density.weights in the config
```
