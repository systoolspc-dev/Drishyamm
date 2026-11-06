# Training with OmniFall — fixing the "bent-forward / squat / occluded-legs" false positives

## Why we're doing this

Our current `models/fall_cnn.pt` (GMDCSA + VideoDataset, s2 sens 0.920 / spec
0.826) was trained only on **staged single-fall clips**. It never saw a person
*squatting*, *kneeling*, *bending to pick something up*, *sitting down*, or
*deliberately lying down*. On real CCTV those postures make it false-fire —
especially when the legs are occluded so the engine-side "grounded gate" can't
veto. We already refused to hard-code more geometry rules (they overfit and this
is going on an open CCTV feed). **The right fix is data.**

[OmniFall](https://huggingface.co/datasets/simplexsigil2/omnifall) re-annotates 8
staged datasets **plus a real in-the-wild set** with a **16-class temporal
taxonomy** that explicitly separates the transient *fall* event from every
look-alike:

```
 0 walk     1 FALL     2 fallen    3 sit_down   4 sitting    5 lie_down
 6 lying    7 stand_up 8 standing  9 other     10 kneel_down 11 kneeling
12 squat_down 13 squatting 14 crawl 15 jump
```

Our adapter maps `fall`(1) → **positive** and *everything else* → **negative**,
so squat/kneel/sit/lie/bend become labeled **hard negatives**. The model learns
the fall-vs-crouch boundary from data instead of from thresholds.

## v2 — closing the seated/quadruped-fall blind spot (DO THIS ONE)

The first OmniFall model (`fall_cnn_omnifall.pt`) was validated on 2026-07-16 and
found to be a **precision/recall trade, not a clean win**:

* WINS: held-out GMDCSA s2 event-level **1.000 sens / 0.913 spec** (vs old
  0.920 / 0.826); kills the squat + shoveling false positives.
* BLIND SPOT: it catches falls that end **lying flat**, but MISSES falls that end
  **seated** or **on hands-and-knees** (common outdoor slip-falls) — e.g. sample 4
  gets fall-probability 0.05. Cause: OmniFall's `sitting`/`squatting`/`kneeling`/
  `crawling` hard negatives bleed into suppressing real falls of that shape.

The fix is data-driven (no new rules): **add real in-the-wild OOPS/of-itw falls as
POSITIVES** — OOPS is full of exactly these outdoor seated/quadruped slip-falls,
and v1 had held it out of training so the model only saw that domain as negatives.
Hold out ~30% of OOPS scenes for honest validation. One command does all of it
(train split of OOPS → train → held-out OOPS split → wild score):

```bash
python -m src.run_pipeline \
    --gmdcsa <GMDCSA root> --videodataset <VideoDataset root> \
    --omnifall-videos <staged VID> --configs le2i,mcfd \
    --oops-videos <OOPS root> --fetch-oops --oops-val-frac 0.3 \
    --holdout s2 --model models/fall_cnn_omnifall_v2.pt
```

`--fetch-oops` runs `omnifall prepare-oops` for you (skip it if OOPS is already
downloaded). Success = the v2 model KEEPS s2 ~1.0/0.91 AND now fires on the
seated/quadruped sample clips (4, 10, 1) while the squat/shovel clips (2, 5) stay
quiet. Only then promote it to `models/fall_cnn.pt`.

## TL;DR — one command (v1, staged only)

Download le2i + mcfd videos into one folder `<VID>` (the only manual step), then:

```bash
python -m src.run_pipeline --omnifall-videos <VID> --configs le2i,mcfd --holdout s2
```

That runs adapters → feature extraction → training end-to-end and writes
`models/fall_cnn_omnifall.pt`. Add `--gmdcsa <root> --videodataset <root>` if
those are on the box too, and `--fetch-oops` to auto-download OOPS and print an
honest in-the-wild score at the end. Use `--dry-run` to preview the steps. The
rest of this doc is the manual breakdown of what that command does.

## Two-part plan

1. **Train** on the staged, precisely-labeled configs (rich hard negatives,
   multi-view, occlusion): `mcfd, le2i, cmdfall, edf, occu` (optionally
   `caucafall, up_fall`) — added on top of GMDCSA + VideoDataset.
2. **Validate honestly in the wild** on `of-itw` (the OOPS-Fall set: real YouTube
   falls). Keep it OUT of training. OmniFall's own finding is that staged-trained
   models collapse to ~0.15–0.21 sensitivity in the wild — of-itw is how we see
   whether we actually closed that gap.

Everything below runs on the **GPU PC** (per the standing constraint). All
installs go in the venv.

---

## Step 0 — env

```bash
cd "fall detection"
python3 -m venv venv                 # if not already
./venv/bin/pip install -r requirements.txt      # now includes `datasets`
./venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121  # CUDA build
```

> **Annotations are already bundled** in `omnifall_annotations/*.csv` (mcfd, le2i,
> cmdfall, edf, occu, caucafall, up_fall, of-itw), so the adapter needs **no
> network** for them — you only fetch the videos. The `datasets` package is only a
> fallback for a config that isn't bundled.

## Step 1 — get the videos

OmniFall's HF repo has **annotations only**. Videos come from their owners:

| config | source |
|---|---|
| `of-itw` (OOPS, in-the-wild) | `./venv/bin/pip install omnifall` then `./venv/bin/omnifall prepare-oops` (streams ~45GB, extracts ~2.6GB) |
| `mcfd` (Multiple Cameras Fall) | https://www.iro.umontreal.ca/~labimage/Dataset/ |
| `le2i` | https://search-data.ubfc.fr/ (search "Le2i fall detection") |
| `cmdfall` | https://www.mica.edu.vn/perso/Tran-Thi-Thanh-Hai/CMDFALL.html |
| `edf`, `occu` | source table in the OmniFall paper/repo |
| `caucafall` | https://data.mendeley.com/datasets/7w7fccy7ky |
| `up_fall` | https://sites.google.com/up.edu.mx/har-up/ |

Put the extracted videos anywhere; point `--videos` at that root. The adapter
finds each file by the annotation path (e.g. `chute21/cam5`) under either
`<root>/<path>.<ext>`, `<root>/<config>/<path>.<ext>`, or by a **scene-aware**
recursive search (it will NOT attach a wrong same-named file from another scene —
it reports anything it can't find and you re-run after fixing the layout).

**Start small**: `mcfd` + `le2i` alone already add strong squat/sit/kneel/lie
negatives and are small downloads. Add `cmdfall` (big: ~188 long multi-cam clips)
when you want maximum coverage.

## Step 2 — build the combined data_raw (GMDCSA + VideoDataset + OmniFall)

Run the adapters **in order** into one shared `data_raw/` + `annotations.csv`:

```bash
# 1) GMDCSA (long, frame-accurate) — subjects s1..s4
./venv/bin/python -m src.data.gmdcsa24    --root <GMDCSA root>       --out data_raw --annotations annotations.csv
# 2) VideoDataset (multi-view short clips) — subjects v01..v29
./venv/bin/python -m src.data.videodataset --root <VideoDataset root> --out data_raw --annotations annotations.csv
# 3) OmniFall staged (hard negatives) — groups mcfdN / le2iN / cmdN / edfN / occuN
./venv/bin/python -m src.data.omnifall --videos <OmniFall video root> \
    --configs mcfd,le2i,cmdfall,edf,occu \
    --out data_raw --annotations annotations.csv
```

Then extract features → windows (this is the slow, GPU-accelerated step):

```bash
./venv/bin/python -m src.data.prepare_dataset --raw data_raw \
    --out data_prepared_omnifall --annotations annotations.csv
```

`prepare_dataset` now supports **multiple fall intervals per video** (OmniFall
clips often contain several falls) — backward compatible with the single-interval
GMDCSA/VideoDataset rows.

## Step 3 — train

Groups are held out by subject/scene, so the split is honest:

```bash
./venv/bin/python -m src.model.train --data data_prepared_omnifall/windows.npz \
    --out models/fall_cnn_omnifall.pt --holdout s2
```

`--holdout s2` keeps GMDCSA subject 2 in validation so the new model's held-out
**s2 sensitivity is directly comparable to the current 0.920**. Also spot-check a
held-out OmniFall scene (e.g. `--holdout mcfd21`) and a VideoDataset subject
(`--holdout v10`).

## Step 4 — validate in the wild (the real test)

Extract of-itw **separately** (keep it out of training) and measure on it:

```bash
./venv/bin/python -m src.data.omnifall --videos <OmniFall video root> \
    --configs of-itw --out data_raw_itw --annotations annotations_itw.csv
./venv/bin/python -m src.data.prepare_dataset --raw data_raw_itw \
    --out data_prepared_itw --annotations annotations_itw.csv
# then evaluate models/fall_cnn_omnifall.pt on data_prepared_itw/windows.npz
```

Compare of-itw window-level sensitivity/specificity **before vs after** adding
OmniFall. That number is the honest measure of whether the false-positive fix
generalizes to real CCTV.

## Step 5 — promote, and re-check the false positives

If s2 sensitivity holds (~0.92) AND of-itw specificity rises (fewer squat/bend
false fires) AND of-itw sensitivity is respectable:

1. `cp models/fall_cnn_omnifall.pt models/fall_cnn.pt`
2. Re-run the real problem clips (the shoveling/squat/bent-forward samples). The
   goal is those stop false-firing **without** the engine-side grounded gate
   doing the work — i.e. the model itself now knows a crouch isn't a fall.
3. Re-tune the state-machine thresholds only if needed (the cache-then-sweep
   method in `docs/` / scratch `sweep_combined.py`).
4. For the **final deployment** model, retrain WITHOUT `--holdout` so all
   subjects/scenes are used.

## Labeling notes (what the adapter does, precisely)

- A video is placed in `data_raw/fall/` if it has ≥1 `fall` segment, else in
  `data_raw/adl/` (a pure hard-negative clip: walk/sit/squat/kneel/lie only).
- For a fall clip, **only the `fall` segments** are written as fall intervals;
  every other segment (including `fallen`, `lying`, `squatting`, ...) stays
  negative. `prepare_dataset` then extends each fall interval by
  `CONFIRM_SECONDS` into the following on-the-floor frames (so the model keeps
  firing while the person is down — matching the engine's sustained-confirm).
- Anti-leakage grouping is per-dataset from the path (cameras/views of one scene
  share a group), because OmniFall's `subject` field is degenerate in several
  configs. Group tokens: `mcfdN`, `le2iN`, `cmdN`, `edfN`, `occuN`, `itwN`.
