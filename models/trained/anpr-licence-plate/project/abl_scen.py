import json, glob

d = json.load(open(sorted(glob.glob("data/eval/ablation_labelled_audit_*.json"))[-1]))
bs = d.get("by_scenario")
print("by_scenario type:", type(bs).__name__)
print(json.dumps(bs, indent=1)[:1800])
rows = d.get("rows") or []
print("\nrows:", len(rows), "| row keys:", sorted(rows[0].keys()) if rows else "-")
if rows:
    from collections import Counter

    win = Counter()
    for r in rows:
        w = r.get("winner") or r.get("best") or r.get("best_variant")
        if w:
            win[w] += 1
    print("winning variant per crop:", win.most_common(12))
