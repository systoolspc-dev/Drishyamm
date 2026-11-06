import json

for name, p in [
    ("A", "data/eval/ablation_labelled_audit_20260903-012614.json"),
    ("B", "data/eval/ablation_labelled_audit_20260903-012804.json"),
    ("C", "data/eval/ablation_labelled_audit_20260903-012955.json"),
]:
    d = json.load(open(p))
    print(name, "conditions:", [r["condition"] for r in d["table"]])
