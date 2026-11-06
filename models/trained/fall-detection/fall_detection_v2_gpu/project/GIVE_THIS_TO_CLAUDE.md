# FOR CLAUDE ON THE GPU PC — read this first, then drive the task

You are Claude Code running on the user's **NVIDIA GPU PC**. The user has unzipped
a fall-detection project here. This file is your briefing: what the project is,
what's already been done, the ONE task to do now, and how to walk the user
through it. Read `CLAUDE.md` and `docs/OMNIFALL.md` too — they have the deep
detail. Be concise with the user; do the thinking yourself.

---

## 1. What this project is (30-second version)

A production CCTV **human fall-detection** pipeline:
`video → YOLO-pose + tracking → camera-invariant features → 2s window → 1-D CNN
→ per-person state machine → FALL event`. It detects falls from body pose, works
multi-person, and is tuned to avoid false alarms. All tunables live in
`config.py`. Training reads prepared `windows.npz` files, never raw video.

## 2. Where things stand (important — this is why you're here)

There are TWO models in play:

- **`models/fall_cnn.pt`** — the CURRENT PRODUCTION model. Held-out GMDCSA s2:
  **0.920 sensitivity / 0.826 specificity** (event-level). Safe but false-fires
  on people squatting/bending.

- **`fall_cnn_omnifall.pt` (v1, already trained here once)** — added the OmniFall
  dataset. It was validated on the user's Mac on 2026-07-16 and found to be a
  **precision/recall trade, NOT a clean win**:
  - WINS: held-out s2 **1.000 / 0.913**; kills the squat + shoveling false alarms.
  - BLIND SPOT: it catches falls that end **lying flat**, but MISSES falls that
    end **seated** or **on hands-and-knees** (common outdoor slip-falls). One
    real fall clip scored fall-probability **0.05** — the model is confident it's
    not a fall. Root cause: OmniFall's `sitting`/`squatting`/`kneeling`/`crawling`
    hard negatives bleed into suppressing real falls of that body shape.

So v1 is not safe to deploy. **Your job is to train v2, which fixes the blind
spot.**

## 3. THE TASK — train v2 (OOPS-as-positive retrain)

The fix is data-driven (no new rules): **add real in-the-wild OOPS/of-itw falls as
POSITIVES.** OOPS is full of exactly those outdoor seated/quadruped slip-falls,
and v1 had held OOPS out of training, so the model only ever saw that domain as
negatives. We hold out ~30% of OOPS scenes for an honest in-the-wild score.

Everything is wired into one orchestrator command. Walk the user through this:

### Step A — environment (one time)
```
python -m venv venv
venv\Scripts\pip install -r requirements.txt
venv\Scripts\pip install omnifall
venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu121
venv\Scripts\python -c "import torch; print('cuda:', torch.cuda.is_available())"
```
(Linux/Mac: `./venv/bin/pip`, `./venv/bin/python`. If cuda is False, see
CLAUDE.md TROUBLESHOOTING — training still runs on CPU, just slower. Match the
cu121 wheel to this box's CUDA from `nvidia-smi`.)

### Step B — find/download the video data
Ask the user for the folder paths of the datasets THIS PC already has (GMDCSA and
VideoDataset — v1 was trained here, so they exist). Then have them download the
two staged sets into ONE folder (`STAGED`):
- le2i → https://search-data.ubfc.fr/ (search "Le2i fall detection")
- mcfd → https://www.iro.umontreal.ca/~labimage/Dataset/
OOPS downloads automatically in the next step (`--fetch-oops`).
Video files are NOT in the project zip (too big); only their labels are, bundled
in `omnifall_annotations/`.

### Step C — run the ONE command
```
venv\Scripts\python -m src.run_pipeline ^
  --gmdcsa "PATH\TO\GMDCSA" --videodataset "PATH\TO\VideoDataset" ^
  --omnifall-videos "PATH\TO\STAGED" --configs le2i,mcfd ^
  --oops-videos "PATH\TO\OOPS" --fetch-oops --oops-val-frac 0.3 ^
  --holdout s2 --model models\fall_cnn_omnifall_v2.pt
```
It downloads OOPS → builds training data (staged + OOPS falls as positives) →
trains v2 → prepares the held-out OOPS split → prints the in-the-wild score.
Tip: add `--dry-run` first to show the user the exact steps without running them.
The slow part is feature extraction (YOLO-pose over every frame) — minutes to
tens of minutes depending on how much data; the GPU makes it fast.

### Step D — read the results
- Per-epoch training log: confirm held-out **s2 stays ~1.0 / 0.91** (don't lose
  the benchmark win).
- Final printed table = held-out **OOPS** score. Success = its **sensitivity is
  clearly higher than v1** (v1 missed most wild seated/quadruped falls).

## 4. What to tell the user at the end

- If s2 held (~1.0/0.91) AND the wild-OOPS sensitivity improved: tell them it
  looks good, and to send `models/fall_cnn_omnifall_v2.pt` back to the Mac.
  **Do NOT promote it to `fall_cnn.pt` yet** — the Mac side re-validates it on the
  real sample clips (the seated/quadruped falls + the squat/shovel non-falls)
  before promotion. That final check is the gate.
- If s2 dropped or OOPS didn't improve: report the numbers plainly and stop —
  don't tweak thresholds blindly. The user/Mac-side will decide next steps.

## 5. Rules & gotchas (from CLAUDE.md — honor these)

- **Do NOT hard-code geometry to fix any single clip.** This goes on an open CCTV
  feed; fixes must come from data. (That principle is WHY we're doing the OOPS
  retrain instead of adding rules.)
- Single framework: **PyTorch** only.
- All tunables in `config.py`. Don't scatter constants.
- Run modules with `python -m src.…` from the project root (not by file path),
  else `ModuleNotFoundError: No module named 'src'`.
- Windows paths: `venv\Scripts\python.exe`. Headless Linux: don't use
  `run_video --show`; write `--out file.mp4`.
- OOM during training → lower `BATCH_SIZE` in config.py. Loss NaN → lower
  `LEARNING_RATE`.
- Sanity-check the wiring anytime (no GPU/data needed):
  `venv\Scripts\python -m tests.smoke_test`.
- `src/model/eval_npz.py --data <windows.npz> --model <model.pt>` scores any
  prepared set (that's what the pipeline uses for the wild score).

## 6. If the user just says "do it"

Confirm the four dataset paths (GMDCSA, VideoDataset, STAGED, OOPS), then run the
Step C command for them, watch it complete, read the results per Step D, and
report per Step 4. Keep them informed but don't dump raw logs — summarize the
numbers that matter (s2 sens/spec, held-out OOPS sens/spec).
