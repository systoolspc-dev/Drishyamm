import json, glob

new = json.load(open(sorted(glob.glob("data/eval/ablation_labelled_audit_*.json"))[-1]))
old = json.load(open("data/eval/ablation_labelled_audit_20260902-155911.json"))


def pct(x):
    return "  n/a " if x is None else "%5.1f%%" % (100 * x)


def num(x, f="%6.3f"):
    return "   n/a" if x is None else f % x


for name, d in (
    ("BEFORE  (stock cct-s-v2, 2 Sep 15:59)", old),
    ("AFTER   (fine-tuned model, deployed 16:00)", new),
):
    rows = sorted(d["table"], key=lambda r: -(r.get("exact_of_all") or 0))
    print("\n== %s -- n=%s crops, primary=%s ==" % (name, d["n"], d["ocr_primary"]))
    print("%-20s%8s%8s%8s%8s%9s" % ("variant", "exact", "raw", "cer", "valid", "ms_prep"))
    for r in rows[:10]:
        print(
            "%-20s%8s%8s%8s%8s%9s"
            % (
                r["condition"],
                pct(r.get("exact_of_all")),
                pct(r.get("raw_exact")),
                num(r.get("cer")),
                pct(r.get("valid")),
                num(r.get("ms_prep"), "%7.1f"),
            )
        )
b = {r["condition"]: r for r in old["table"]}
print("\n== per-variant change on the SAME crops ==")
for r in sorted(new["table"], key=lambda r: -(r.get("exact_of_all") or 0))[:10]:
    o = b.get(r["condition"])
    if not o:
        continue
    print(
        "%-20s %5.1f%%  -> %5.1f%%   %+5.1f pts"
        % (
            r["condition"],
            100 * (o.get("exact_of_all") or 0),
            100 * (r.get("exact_of_all") or 0),
            100 * ((r.get("exact_of_all") or 0) - (o.get("exact_of_all") or 0)),
        )
    )
