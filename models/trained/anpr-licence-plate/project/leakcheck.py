import hashlib, os, csv


def h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


audit = {}
ad = "data/labelled_audit"
for n in os.listdir(ad):
    if n.lower().endswith((".jpg", ".jpeg", ".png")):
        audit[h(os.path.join(ad, n))] = n
tr, va = set(), set()
for name, bucket in (("train.csv", tr), ("val.csv", va)):
    p = os.path.join("data/train/ocr", name)
    if not os.path.exists(p):
        continue
    with open(p) as f:
        for row in csv.DictReader(f):
            ip = os.path.join("data/train/ocr", row["image_path"])
            if os.path.exists(ip):
                bucket.add(h(ip))
print("audited crops:", len(audit))
print("train images hashed:", len(tr), "| val images hashed:", len(va))
print("audited crops ALSO in train:", len(set(audit) & tr))
print("audited crops ALSO in val:  ", len(set(audit) & va))
