# ANPR experiments

`registry.yaml` is the **plan**: one entry per experiment with its hypothesis, what changes, which
model and dataset version it runs on, hyper-parameters, seed, and how it is validated. Every metric
field in the registry is literally `NOT MEASURED` — numbers are never typed into it.

`run_experiment.py` is the **ledger**: it attaches an evaluation JSON (from `eval_labels.py`,
`ablation_preprocess.py`, `eval_e2e.py` or `eval_detector.py`) to an experiment id and writes
`data/experiments/<id>_<stamp>.json` with everything needed to reproduce the number:

| field | where it comes from |
|---|---|
| `git_commit` | `git rev-parse HEAD` (+`-dirty`) when run from the checkout; `unknown` inside the container unless `--commit`/`ANPR_GIT_COMMIT` is given |
| `dataset.train_csv_sha256`, `val_csv_sha256` | sha256 of `data/train/ocr/{train,val}.csv` (absent → `null`) |
| `dataset.counts` | files under `records/`, `review/`, `labelled/`, `labelled_audit/`, `train/det/images` at that moment |
| `models` | sha256 of `models/*.pt`, `models/ocr/model.onnx`, `plate_config.yaml`, `calibrator.json`; `ANPR_OCR_READERS` |
| `seed` | `--seed`, else the registry entry's seed |
| `env` | every `ANPR_*` variable (secrets masked) |
| `metrics` | the eval JSON copied whole, plus its sha256 and the extracted `key_metrics` |

```
python run_experiment.py --id Baseline --metrics data/eval/labels_20260902-113053.json --note "…"
python run_experiment.py --list
```

`--list` shows each entry with the latest record per metric kind; anything without a record prints
`NOT MEASURED`.

## The entries

| id | what changes | trains? | seed | validated by |
|---|---|---|---|---|
| Baseline | nothing — stock models, deployed gates | no | – | eval_labels, ablation, e2e (GT clip), detector (independent boxes) |
| E1 | gate recalibration from the sweeps, superstring length rule, single-read possible tier | no | – | eval_labels before/after on the same pull, e2e on ≥ 2 GT clips |
| E2 | OCR fine-tune cct-s-v2, group split by plate, + synthetic, lr 1e-4, 30 ep | yes | 42 | train_ocr val gate, ablation on labelled_audit, post-deploy labels |
| E3 | plate detector fine-tune, hard negatives, imgsz 960 | yes | 0 | eval_detector on hand-boxed frames, bench_gpu |
| E4 | 11-slot OCR head | yes | 42 | ablation on 11-char crops + no regression |
| E5 | logistic calibrator on read features | yes | 7 | CV AUC, reliability/ECE vs heuristic |

## Rules

* **Exact match only.** A plate is right when the whole normalised string is equal. CER is reported
  beside it, never instead of it.
* **Human labels are the evidence.** Auto labels (`source=auto`) are the model's own confident reads;
  they appear in reports only to say how many there are.
* **Independent ground truth for the detector.** `data/train/det` is the detector's own output;
  `eval_detector.py` refuses it unless `--allow-self-labels`, and then stamps `independent_gt=false`.
* **Same pull, before and after.** A worker-only change (E1) is scored on the label pull saved with
  `eval_labels.py --save-api`, so the two numbers differ only by the change.
* **Small n → say so.** Every accuracy carries a Wilson 95 % interval; buckets under `--min-n` are marked.
