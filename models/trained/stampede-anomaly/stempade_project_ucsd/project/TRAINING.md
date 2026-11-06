# Training runbook

Implementation of [pipeline.md](pipeline.md) over the **UCSD Anomaly Detection
Dataset**, which is this project's only data source — training, validation and
evaluation all come from UCSD.

A full run has been completed; see [Measured results](#measured-results) at the
end for what it produced and what the numbers do and do not mean.

---

## Setup on the training machine

```bash
pip install -r requirements.txt
```

Verified against Python 3.11, TensorFlow 2.16.2 / Keras 3, OpenCV 4.11,
NumPy 1.26. `scikit-image` is deliberately not a dependency: SSIM is
implemented directly from the paper's equations (7)–(12).

Copy the whole project folder, including `datasets/ucsd/` (1.2 GB extracted).
Nothing is downloaded at runtime.

---

## Three stages

```bash
# 1. frames -> optical flow + descriptors + labels   (CPU-bound)
python src/preprocess.py                    # both subsets, Train + Test, 98 clips
python src/preprocess.py --workers 8        # one clip per worker process

# 2. train
python src/train.py

# 3. evaluate
python src/evaluate.py --run <run_name>              # four-class, Fig. 9/10, Table 7
python src/evaluate.py --run <run_name> --anomaly    # binary, vs UCSD's own GT
python src/evaluate.py --run <run_name> --latency    # Table 8
```

`preprocess.py` must run before `train.py`. It is one command — there is no
ordering constraint between datasets any more, because there is only one
dataset. It writes `cache/<clip>/`:

| file | shape | content |
|---|---|---|
| `flow.f16` | (N, 224, 224, 2) | float16 flow, normalised to [-1, 1] |
| `scalars.npy` | (N, 4) | raw descriptors, for inspection |
| `bits.npy` | (N, 32) | binarised descriptors, the model input |
| `occupancy.npy` | (N,) | the density proxy, for inspection |
| `labels.npy` | (N,) | int8 class ids |

Budget roughly **196 KB per frame** of flow cache. The full corpus is 18,462
flow frames (18,560 source frames, one consumed per clip to start the flow
series), so the cache lands near **3.5 GB**. `FRAME_BUDGET = 0` in
`src/config.py` keeps every frame; set it to `10000` to subsample down to the
paper's corpus size.

---

## Labels — the part that is not in the paper

The paper classifies every frame as `normal` / `moderate` / `dense` / `risky`
from a hand annotation of 10,000 frames that was **never published**. UCSD
ships only a *binary* frame-level annotation. The four classes are therefore
rebuilt from UCSD alone, by two rules (`src/ucsd_labels.py`):

**`risky` — UCSD's own ground truth.** Exactly the frames flagged in
`Test/<subset>.m`. Not a proxy, not derived; honoured verbatim.

**`normal` / `moderate` / `dense` — tertiles of a crowd-density proxy**, taken
over every frame *not* flagged anomalous. The proxy is foreground occupancy:

1. Build a background plate per subset — the per-pixel median over every 10th
   frame of that subset's `Train` clips, at the pipeline's 224×224 working
   resolution. UCSD is a fixed camera and its Train clips are all-normal, so
   the median is a clean empty-walkway image. A *mean* would smear every
   passer-by into the plate; the median discards them as the minority
   observation at each pixel.
2. Foreground = pixels differing from the plate by more than `20/255`, after a
   3×3 morphological open. Verified by rendering the masks: they resolve
   individual pedestrians and merge only in genuinely dense groups.
3. Occupancy = the foreground fraction, median-smoothed over 5 frames.
4. Cut the corpus-wide occupancy distribution at its tertiles.

Measured over the corpus, this gives roughly **31 % risky / 23 % each for the
other three** — close to the paper's stated ~2,500 frames per class out of
10,000, and reached without any hand annotation.

### Three honest caveats about these labels

**UCSD's anomalies are not stampedes.** They are bicycles, skateboards, carts
and wheelchairs on a pedestrian walkway. Mapping them to `risky` borrows UCSD's
only ground truth for the paper's top class. It is the correct label for "this
frame is abnormal", not for "this frame is a crowd crush".

**Occupancy is a pixel-area measure under perspective.** A group at the far end
of the walkway registers lower than the same group near the camera. Correcting
for that would need a ground-plane homography UCSD does not ship.

**Density is close to constant within a clip.** Measured: whole Train clips come
out 100 % `dense` or 94 % `normal`, because a 120–200 frame clip is a few
seconds of one crowd. That means the density classes are partly *clip*
identity, and a model can score well on them by recognising a clip's
background rather than its density. `--anomaly` is the readout that is immune
to this, because `risky` is annotated per frame *within* clips.

---

## Things measured during implementation that change the spec

**The literal architecture does not fit in memory.** Flatten produces 100,352
features per frame; feeding that straight into a 256-unit LSTM is
**103,056,384 parameters in that one layer** (measured, `CNN_BOTTLENECK = 0`),
which contradicts both the paper's 12 GB training GPU and its 0.078 s/frame CPU
inference. A 256-unit projection is inserted after Flatten, giving 26.5 M
parameters total. Set `CNN_BOTTLENECK = 0` in `src/config.py` to build the
literal spec and see it fail.

**The stated feature ranges are wrong.** The paper quantizes acceleration,
divergence and scene-change from `[0, 1]` and entropy from `[0, 4]`. Measured
p1–p99 over all 18,462 UCSD flow frames:

| descriptor | paper's range | measured on UCSD |
|---|---|---|
| acceleration | 0 – 1 | 0.065 – 0.232 |
| divergence | 0 – 1 | 0.089 – 0.292 |
| scene change | 0 – 1 | 0.001 – 0.029 |
| entropy | 0 – 4 | 1.08 – 2.80 (at `FLOW_CLIP = 3.0`) |

Quantized as specified, every descriptor would spend most of its 8-bit budget
on values that never occur. `CALIBRATE_SCALARS = True` rescales each descriptor
to its empirical [p1, p99] across the corpus, written to
`cache/scalar_ranges.json`. Set to `False` to quantize with the paper's stated
ranges.

**`FLOW_CLIP` was re-derived on UCSD.** It sets both the input scale and the
motion-entropy histogram span, so it was chosen by sweeping both at once over
234 UCSD flow fields:

| `FLOW_CLIP` | entropy spread | pixels clipped |
|---|---|---|
| 1.5 | 1.45 | 0.97 % |
| 2.0 | 1.54 | 0.49 % |
| **3.0** | **1.56** | **0.10 %** |
| 4.0 | 1.52 | 0.03 % |
| 20 | 0.78 | 0.00 % |

3.0 is best on both axes. The paper's implied 20 collapses entropy to a median
of 0.39 bits — a dead input, which is what its stated `[0, 4]` entropy range
amounts to.

**Grayscale input takes the flow stage's single-channel path.** Paper Sec. 4.2
runs Farneback on all three RGB channels and averages them. UCSD frames are
grayscale, so the three channels are identical and eq. (2) reduces *exactly* to
the single-channel flow — averaging three copies of a field returns that field.
`farneback_multichannel()` detects this and computes once, which is not an
approximation and cuts the pipeline's dominant cost to a third. Colour input
still takes the full three-channel path.

**Validation is split by clip, never by window, and it is stratified.**
Consecutive windows share 12 of their 16 frames, so a random window split puts
near-duplicate sequences on both sides and inflates validation accuracy. On top
of that, only Test clips carry anomalies and density is near-constant within a
clip, so an unstratified draw of 20 clips from 98 can land a validation set with
almost no `risky` windows or no `dense` ones at all — and early stopping
monitors validation accuracy, so a validation set missing a class silently
changes what is being optimised. `split_by_clip()` samples each
subset/split/dominant-class group at `VAL_FRACTION` independently.

---

## Knobs

All in `src/config.py`. Values from the paper are marked `[paper]`; choices this
implementation had to make are marked `[gap]`; values re-derived for UCSD are
marked `[ucsd]`.

| setting | default | note |
|---|---|---|
| `SEQ_LEN` / `SEQ_OVERLAP` | 16 / 12 | [paper] stride 4 |
| `BATCH_SIZE` | 8 | [paper] Table 3 |
| `LEARNING_RATE` | 1e-3 | [paper] Adam |
| `EPOCHS` | 40 | [paper] Table 5 |
| `EARLY_STOPPING_PATIENCE` | 10 | [paper] Sec. 6.1, on `val_accuracy` |
| `CNN_BOTTLENECK` | 256 | [gap] required; 0 = literal paper spec |
| `FLOW_CLIP` | 3.0 | [ucsd] swept on UCSD, see above |
| `WINDOW_LABEL` | `"max"` | [gap] `"mode"` preserves class balance |
| `FRAME_BUDGET` | 0 | 0 = all 18,462 flow frames; 10000 = paper's size |
| `UCSD_SUBSETS` | both | `("UCSDped1", "UCSDped2")` |
| `FG_THRESHOLD` / `DENSITY_QUANTILES` | 20/255, tertiles | label derivation |
| `SEED` | 42 | [paper] fixed seed, value unstated |

`WINDOW_LABEL` is worth a look before a long run. `"max"` labels a window with
the highest risk class in it, which is what a warning system wants but skews the
window-level balance upward relative to the frame-level balance. `"mode"`
preserves the balance. `train.py` prints the resulting class counts for both
splits before it starts.

---

## Ablations

The paper says in Sec. 7 that ablations comparing CNN-LSTM with scalars, without
scalars, and against a lightweight 3D CNN "will be applied", then never reports
them. All three are implemented:

```bash
python src/train.py                    # (i)   CNN-LSTM + scalar descriptors
python src/train.py --no-scalars       # (ii)  CNN-LSTM, flow only
python src/train.py --arch 3dcnn       # (iii) lightweight 3D-CNN baseline
```

---

## What to expect

Do not expect the paper's 99.75 %. That number comes from an unpublished hand
annotation, an unstated train/validation split, and a 260-sequence validation
set — and its own Table 6 contradicts the surrounding text about which class was
predicted. The labels here are derived from UCSD by a documented rule, so the
numbers are reproducible, but they are measuring a different labelling.

Read the two evaluation modes differently:

- `--anomaly` is the one to trust. `risky` is UCSD's own published frame-level
  annotation, so risky-vs-rest with a Youden's J threshold measures the model
  against real ground truth. This is also the closest analogue to the paper's
  Sec. 6.6 protocol, which reports a threshold of 0.5512.
- The four-class confusion matrix depends on the density proxy defined here.
  Because density is close to constant within a clip, treat a high four-class
  accuracy as partly a measure of clip recognition until the `--anomaly` numbers
  agree with it.

---

## Measured results

Run `ucsd_gpu`, all defaults (`WINDOW_LABEL="max"`, 77/21 clip split, seed 42),
on an RTX PRO 5000 under WSL2 with TF 2.21 + CUDA 12.9. 3,346 train / 907 val
windows. Early stopping fired at epoch 33; weights restored from **epoch 23**.

| | train | val |
|---|---|---|
| accuracy | 0.956 | **0.552** |
| loss | 0.170 | 2.084 |

**Four-class, held-out clips — 501/907 correct (55.2 %)**

| | pred normal | moderate | dense | risky |
|---|---|---|---|---|
| **true normal** | 146 | 59 | 2 | 4 |
| **moderate** | 58 | 69 | 46 | 20 |
| **dense** | 0 | 26 | 117 | 42 |
| **risky** | 8 | 40 | 101 | 169 |

| class | precision | recall | F1 | AUC | support |
|---|---|---|---|---|---|
| normal | 0.689 | 0.692 | 0.690 | 0.892 | 211 |
| moderate | 0.356 | 0.358 | 0.357 | 0.673 | 193 |
| dense | 0.440 | 0.632 | 0.519 | 0.768 | 185 |
| risky | 0.719 | 0.531 | 0.611 | 0.809 | 318 |

**Anomaly vs UCSD's own annotation** — 10 clips, 443 windows, 318 abnormal:
ROC AUC **0.7485**, Youden's J threshold 0.0048, abnormal recall 0.742
(236/318), normal recall 0.624 (78/125).

**Latency** — 0.144 s per 16-frame sequence, 111 FPS. Not comparable to the
paper's 0.173 s / 12.77 FPS: that was 24-thread CPU, this is GPU inference, and
this pipeline's flow stage is 3x cheaper on grayscale input.

### Reading these numbers

**The train/val gap is the story: 0.956 vs 0.552.** The model fits the training
clips almost perfectly and transfers poorly. This is the failure predicted in
"Labels" above — density is near-constant within a UCSD clip, so `normal` /
`moderate` / `dense` are largely *clip identity*, and memorising which clip is
which cannot generalise to held-out clips. Validation loss confirms it, rising
from 1.02 to 3.19 while training loss fell to 0.11.

**The class pattern matches that diagnosis.** `moderate` is worst (F1 0.357,
AUC 0.673) — it is the middle tertile, the class whose boundaries are pure
threshold artefacts. `normal` is best (F1 0.690, AUC 0.892) because sparse
walkways genuinely look different. Errors concentrate between *adjacent*
density grades, which is what a real but noisy density signal looks like.

**The paper's "zero normal/risky confusion" does not reproduce**: 12 such
errors here (4 + 8). Expected — the paper's `risky` was hand-annotated crowd
density, while this project's is UCSD's bicycles-and-skateboards annotation.

**AUC 0.75 on the anomaly task is the honest headline.** It is the only number
scored against published ground truth, and it is scored *within* clips, so clip
memorisation does not inflate it. The Youden's J threshold of 0.0048 is worth
noting on its own: the model almost never emits a confident `risky` probability,
so the operating point sits far into the tail. That is a calibration problem,
not only an accuracy one.

**Do not compare any of this to the paper's 99.75 %.** Different labels,
different task. See "What to expect" above.

---

## File map

| file | role |
|---|---|
| `src/config.py` | every constant, each tagged `[paper]`, `[gap]` or `[ucsd]` |
| `src/features.py` | flow (eq. 1–2), descriptors (eq. 3–14), quantization |
| `src/ucsd_labels.py` | background plate, density proxy, four-class derivation |
| `src/datasets_io.py` | UCSD clip loaders and the `.m` annotation parser |
| `src/preprocess.py` | stage 1 CLI |
| `src/sequence.py` | windowing, memmap generator, stratified clip-wise split |
| `src/model.py` | CNN-LSTM (Tables 1–2) + 3D-CNN baseline |
| `src/train.py` | stage 2 CLI |
| `src/evaluate.py` | stage 3 CLI: confusion, ROC, Youden's J, latency |
