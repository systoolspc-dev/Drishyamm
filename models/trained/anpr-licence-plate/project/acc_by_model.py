import csv, json, datetime as dt

CUT = dt.datetime(2026, 9, 2, 16, 0, 0)  # fine-tuned reader deployed (models/ocr/MODEL_CARD.txt)
ts = {}
for r in csv.reader(open("/srv/anpr/sighting_ts.csv")):
    if len(r) >= 2 and r[1]:
        try:
            ts[r[0]] = dt.datetime.strptime(r[1], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
d = json.load(open("/srv/anpr/data/eval/labels_pull_20260903_post.json"))


def norm(s):
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def wilson(k, n, z=1.96):
    if not n:
        return (0.0, 0.0, 0.0)
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / den
    return (100 * p, 100 * max(0, c - half), 100 * min(1, c + half))


buckets = {"before": [], "after": [], "unknown": []}
for row in d["labels"]:
    if (row.get("source") or "").lower() == "auto":
        continue
    v = (row.get("verdict") or "").lower()
    if v not in ("correct", "wrong"):
        continue  # not_plate is not a read
    t = ts.get(row.get("sighting_id") or "")
    key = "unknown" if t is None else ("after" if t >= CUT else "before")
    ok = 1 if (v == "correct" or norm(row.get("plate_read")) == norm(row.get("plate_true"))) else 0
    buckets[key].append(ok)
print("Exact-match accuracy of POSTED reads, human labels only (officer + auditor)")
print("split at 2026-09-02 16:00 UTC, when the fine-tuned reader was promoted\n")
print("%-34s %5s %7s %9s   %s" % ("reads judged by a person", "n", "exact", "accuracy", "Wilson 95% CI"))
for key, label in (
    ("before", "read posted by the STOCK reader"),
    ("after", "read posted by the FINE-TUNED reader"),
    ("unknown", "sighting no longer in the database"),
):
    b = buckets[key]
    k = sum(b)
    n = len(b)
    if not n:
        print("%-34s %5d %7s %9s" % (label, 0, "-", "-"))
        continue
    a, lo, hi = wilson(k, n)
    print("%-34s %5d %7d %8.1f%%   [%.1f, %.1f]" % (label, n, k, a, lo, hi))
allb = buckets["before"] + buckets["after"] + buckets["unknown"]
a, lo, hi = wilson(sum(allb), len(allb))
print("%-34s %5d %7d %8.1f%%   [%.1f, %.1f]" % ("ALL human-labelled reads", len(allb), sum(allb), a, lo, hi))
