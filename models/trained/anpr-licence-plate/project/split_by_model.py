import json

p = "data/eval/labels_pull_20260903_0330.json"
d = json.load(open(p))
rows = d if isinstance(d, list) else (d.get("labels") or d.get("items") or d.get("rows") or [])
print("pull keys:", list(d)[:10] if isinstance(d, dict) else "list", "| rows:", len(rows))
if rows:
    print("row keys:", sorted(rows[0].keys()))
    print("sample:", json.dumps(rows[0])[:400])
