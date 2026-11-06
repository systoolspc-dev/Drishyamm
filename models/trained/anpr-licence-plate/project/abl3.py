import json

runs = [
    ("A current (retinex+inverted in)", "data/eval/ablation_labelled_audit_20260903-012614.json"),
    ("B without retinex", "data/eval/ablation_labelled_audit_20260903-012804.json"),
    ("C without retinex+inverted", "data/eval/ablation_labelled_audit_20260903-012955.json"),
]
keys = ["ensemble", "enhanced_best_valid", "base", "resize_only", "none", "oracle_any_variant"]
print("exact match on the same 154 held-out audited crops (deployed fine-tuned reader)\n")
print("%-32s %s" % ("variant set", "  ".join("%-19s" % k for k in keys)))
for name, path in runs:
    d = json.load(open(path))
    t = {r["condition"]: r for r in d["table"]}
    cells = []
    for k in keys:
        r = t.get(k)
        cells.append(
            "%-19s" % ("n/a" if not r else "%5.1f%% (%3d/%d)" % (100 * r["exact_of_all"], r["exact"], d["n"]))
        )
    print("%-32s %s" % (name, "  ".join(cells)))
print("\nprep cost per crop (ms) and OCR calls implied by the variant set")
for name, path in runs:
    d = json.load(open(path))
    t = {r["condition"]: r for r in d["table"]}
    e = t.get("ensemble") or {}
    print("%-32s ensemble prep %6.1f ms   ms_ocr %6.1f" % (name, e.get("ms_prep") or 0, e.get("ms_ocr") or 0))
