"""
vehicle_types.py — ONE Indian vehicle vocabulary for the whole ANPR stack.

Three worlds name vehicles differently:
  • the detector — COCO ("car", "motorcycle", "bus", "truck"; no auto-rickshaw
    at all) or our IDD fine-tune ("autorickshaw", "motorcycle", "rider", …)
  • VAHAN — registration classes ("LMV", "Motor Cycle", "3WN", "Goods Carrier",
    "Omni Bus", "E-Rickshaw(P)" …)
  • the console / the officer — "car", "bike", "auto", "bus", "truck"

Everything maps onto the CANONICAL set below, so the appearance check (does
the same plate look like the same vehicle on two cameras?), the console filter
and the VAHAN cross-check ("the plate says bike, the camera says auto") all
speak the same language. Keep this file identical to
ai_service/vms_face/services/vehicle_types.py (the API imports that copy).

Canonical classes and the policy each gets:
  car, motorcycle, autorickshaw, bus, truck           → detected, tracked, OCR
  erickshaw   (often unregistered)                    → detected, tracked, OCR attempted, plateless is normal
  tractor     (trolley plates missing / odd places)   → detected, tracked, OCR attempted
  vehicle     (detector fallback: unknown motorised)  → detected, tracked, OCR
  bicycle, handcart, animal, person                   → NOT vehicles for ANPR: no OCR budget
"""

from __future__ import annotations

import re

CANONICAL: tuple[str, ...] = (
    "car",
    "motorcycle",
    "autorickshaw",
    "bus",
    "truck",
    "erickshaw",
    "tractor",
    "vehicle",
)
# things a detector may emit that we deliberately never OCR
NON_VEHICLE: tuple[str, ...] = ("bicycle", "handcart", "person", "rider", "animal")

# Officer-facing labels (short, radio-friendly)
DISPLAY: dict[str, str] = {
    "car": "car",
    "motorcycle": "bike",
    "autorickshaw": "auto",
    "bus": "bus",
    "truck": "truck",
    "erickshaw": "e-rickshaw",
    "tractor": "tractor",
    "vehicle": "vehicle",
}

# ── detector names → canonical ───────────────────────────────────────────────
# COCO (yolov8n.pt) ids and names, IDD detection names, and our own fine-tune
# names all resolve through this table. Anything unknown → None (ignored).
DETECTOR_NAMES: dict[str, str] = {
    # COCO
    "car": "car",
    "motorcycle": "motorcycle",
    "motorbike": "motorcycle",
    "bus": "bus",
    "truck": "truck",
    "bicycle": "bicycle",
    "person": "person",
    # IDD detection
    "autorickshaw": "autorickshaw",
    "auto rickshaw": "autorickshaw",
    "auto-rickshaw": "autorickshaw",
    "rider": "rider",
    "vehicle fallback": "vehicle",
    "vehicle_fallback": "vehicle",
    "caravan": "vehicle",
    "trailer": "truck",
    "train": None,
    "animal": "animal",
    "traffic sign": None,
    "traffic light": None,
    "trafficsign": None,
    "trafficlight": None,
    # ours / legacy worker labels
    "bike": "motorcycle",
    "auto": "autorickshaw",
    "e-rickshaw": "erickshaw",
    "erickshaw": "erickshaw",
    "tractor": "tractor",
    "vehicle": "vehicle",
    "tempo": "truck",
    "lorry": "truck",
    "van": "car",
}
COCO_IDS: dict[int, str] = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 1: "bicycle", 0: "person"}


def from_detector(name_or_id, names: dict | list | None = None) -> str | None:
    """Detector class (id or name) → canonical, or None when it is not a vehicle
    we track. `names` is the model's id→name map (ultralytics `model.names`)."""
    if isinstance(name_or_id, (int, float)):
        i = int(name_or_id)
        if names:
            nm = names[i] if isinstance(names, list) else names.get(i)
            if nm is None:
                return None
            return from_detector(str(nm))
        return COCO_IDS.get(i)
    key = str(name_or_id).strip().lower()
    canon = DETECTOR_NAMES.get(key, key if key in CANONICAL else None)
    if canon in NON_VEHICLE:
        return None
    return canon


def trackable_ids(names: dict | list) -> list[int]:
    """Which class ids of a model are vehicles we track (feeds the detector's
    `classes=` filter). Works for COCO and for our IDD fine-tune alike."""
    items = enumerate(names) if isinstance(names, list) else names.items()
    return [int(i) for i, nm in items if from_detector(str(nm)) is not None]


# ── VAHAN registration class → canonical ─────────────────────────────────────
# Real VAHAN "vehicle_category_description" / class strings are free text and
# vary by RTO software; match on keywords, most specific first.
_VAHAN_RULES: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"e[- ]?rick|e[- ]?cart|battery.*rick", re.I), "erickshaw"),
    (re.compile(r"3\s*W|three\s*wheel|auto\s*rick|rickshaw|3WN|3WT|3WC", re.I), "autorickshaw"),
    (
        re.compile(r"motor\s*cycle|m[- ]?cycle|scooter|moped|two\s*wheel|2\s*W|MCWG|MCWOG|MCWOG|bike", re.I),
        "motorcycle",
    ),
    (re.compile(r"tractor|trolley|trailer.*agri|harvester", re.I), "tractor"),
    (re.compile(r"\bbus\b|omni\s*bus|maxi\s*cab|stage\s*carriage|contract\s*carriage|PSV.*bus", re.I), "bus"),
    (
        re.compile(
            r"goods|truck|lorry|HGV|MGV|LGV|HMV|tipper|tanker|carrier|tempo|dumper|\bLCV\b|\bHCV\b", re.I
        ),
        "truck",
    ),
    (re.compile(r"\bLMV\b|motor\s*car|\bcar\b|jeep|taxi|cab|SUV|MPV|van|LMV-NT|LMV-TR", re.I), "car"),
)


def from_vahan(vehicle_class: str | None) -> str | None:
    """VAHAN class text → canonical (None when unknown / empty)."""
    if not vehicle_class:
        return None
    s = str(vehicle_class)
    for rx, canon in _VAHAN_RULES:
        if rx.search(s):
            return canon
    return None


# ── comparisons ──────────────────────────────────────────────────────────────
# Classes a camera detector legitimately confuses with each other (an auto
# seen from behind can be boxed as a car by COCO; a tempo as a truck or a car).
_COMPATIBLE: dict[str, set[str]] = {
    "car": {"car", "vehicle"},
    "motorcycle": {"motorcycle", "vehicle"},
    "autorickshaw": {"autorickshaw", "vehicle", "erickshaw"},
    "erickshaw": {"erickshaw", "autorickshaw", "vehicle"},
    "bus": {"bus", "truck", "vehicle"},
    "truck": {"truck", "bus", "tractor", "vehicle"},
    "tractor": {"tractor", "truck", "vehicle"},
    "vehicle": set(CANONICAL),
}


def canonical(v: str | None) -> str | None:
    """Any label (detector, legacy 'bike', VAHAN text) → canonical or None."""
    if not v:
        return None
    c = from_detector(v)
    if c:
        return c
    return from_vahan(v)


# ── what may honestly be SHOWN, given the detector actually loaded ───────────
# A detector with no `autorickshaw` class (i.e. stock COCO) cannot report an
# auto. It does not decline to answer - it picks the nearest class it owns, so
# every auto in Gujarat traffic comes back as car, bus or truck. That is not a
# threshold to tune: the correct answer is not in the model's vocabulary.
#
# This first kept `motorcycle` and collapsed only car/bus/truck, on the
# evidence that of 42 plates carrying contradictory types, 36 sat inside the
# car/bus/truck triad and only 6 involved `motorcycle`. That reasoning was
# wrong, and the way it was wrong is worth keeping written down:
#
#   counting plates that get TWO DIFFERENT types measures INSTABILITY, not
#   error. A vehicle the detector misreads the same way every time is
#   invisible to it - which is precisely the failure here. An auto called
#   "truck" on every frame is stable and wrong; a Honda Amaze called
#   "motorcycle" on every frame is stable and wrong.
#
# Both were then found in the live records (GJ32U2076, an auto, filed as truck;
# GJ04EA9033, a saloon car, filed under the Bike filter). Frame-edge truncation
# was checked as a narrower explanation and does not hold - 3.1% of
# `motorcycle` rows touch a frame edge against 1.9% of `car`. And the class is
# not merely noisy but barely firing: 32 of 3,555 typed rows (0.9%) are
# `motorcycle`, in traffic that is nearer a third two-wheelers.
#
# So no COCO vehicle class survives on these camera angles. Without an
# auto-capable detector this deployment cannot honestly report a vehicle TYPE
# at all, and says `vehicle` for every one of them rather than picking a word
# that is wrong often enough for an officer to notice.
#
# Types COCO cannot produce (autorickshaw, erickshaw, tractor) are passed
# through: if one of those is present it came from a fine-tune or from VAHAN,
# neither of which this rule is about.
#
# The detector's raw guess is still recorded alongside
# (meta.vehicle_type_raw) for forensics and for re-deriving labels once a
# fine-tune lands - nothing is thrown away, it just stops being asserted.
#
# `train_vehicle_detector.py` is the fix that retires this: a model WITH an
# autorickshaw class passes through untouched.
COARSE_WITHOUT_AUTO: frozenset = frozenset({"car", "bus", "truck", "motorcycle"})


def detector_has_auto(names) -> bool:
    """True when the loaded detector can actually name an auto-rickshaw."""
    if not names:
        return False
    vals = names.values() if isinstance(names, dict) else names
    return any(from_detector(str(v)) == "autorickshaw" for v in vals)


def shown(canon: str | None, has_auto: bool) -> str | None:
    """Canonical type → the type it is honest to SHOW.

    With an auto-capable detector this is the identity. Without one, the three
    classes an auto is silently folded into become the generic `vehicle`, so
    the console says "vehicle" rather than swearing an auto is a truck.
    """
    if not canon:
        return None
    if has_auto:
        return canon
    return "vehicle" if canon in COARSE_WITHOUT_AUTO else canon


def compatible(a: str | None, b: str | None) -> bool:
    """True when two observed vehicle types could be the same vehicle (used by
    the cross-camera appearance check). Unknown on either side → compatible."""
    ca, cb = canonical(a), canonical(b)
    if ca is None or cb is None:
        return True
    return cb in _COMPATIBLE.get(ca, {ca})


def registry_mismatch(camera_type: str | None, vahan_class: str | None) -> dict | None:
    """The police-facing check: does the vehicle on camera match what the plate
    is registered as? Returns None when consistent or unknown, else a dict
    {camera, registered, reason} — a LEAD (stolen / cloned plate signal), never
    a verdict: a COCO detector calls autos 'car' from behind, so the flag only
    fires on hard contradictions (bike vs auto/car/truck, car vs bike, …)."""
    cam = canonical(camera_type)
    reg = from_vahan(vahan_class)
    if cam is None or reg is None or cam == "vehicle":
        return None
    if compatible(cam, reg):
        return None
    # soft pairs a detector confuses → do not flag
    soft = {("car", "autorickshaw"), ("autorickshaw", "car"), ("truck", "car"), ("car", "truck")}
    if (cam, reg) in soft:
        return None

    def _a(word: str) -> str:  # "an auto", "a bike", "an e-rickshaw"
        return ("an " if word[:1].lower() in "aeiou" else "a ") + word

    return {
        "camera": cam,
        "registered": reg,
        "reason": f"plate is registered as {_a(DISPLAY.get(reg, reg))} but the camera saw {_a(DISPLAY.get(cam, cam))} — "
        f"possible stolen or cloned plate; a lead for an officer, not a verdict",
    }


# ── colour, the second half of the registry cross-check ──────────────────────
#
# WHY. registry_mismatch above compares CLASS, which catches a motorcycle plate
# on a truck but is blind to the more common swap: a plate moved between two
# cars. Both are LMV, so class agrees and nothing fires. Colour is the signal
# that separates them — VAHAN records the registered colour, and the worker
# already votes a dominant body colour off the vehicle crop.
#
# IT IS A WEAKER SIGNAL AND IS LABELLED AS ONE. Three ways it lies:
#
#   Night and IR. Under infrared everything is grey. The check refuses to run
#   when the scene was dark rather than reporting a mismatch it cannot support.
#
#   Neutrals. White, silver and grey are the same car in different light, and
#   dark blue or bottle green photograph as black. Those pairs are listed as
#   confusable and never flagged.
#
#   Repaints and registry lag. A legally repainted vehicle mismatches until the
#   owner updates the record. That is exactly why this is a lead and not a
#   verdict, and why the reason says so in words an officer can read out.
_COLOUR_WORDS: dict[str, str] = {
    "white": "white",
    "silver": "silver",
    "grey": "grey",
    "gray": "grey",
    "black": "black",
    "red": "red",
    "maroon": "red",
    "cherry": "red",
    "orange": "orange",
    "yellow": "yellow",
    "golden": "yellow",
    "gold": "yellow",
    "green": "green",
    "blue": "blue",
    "brown": "brown",
    "beige": "brown",
}

# Pairs a camera legitimately confuses. Order does not matter.
_COLOUR_CONFUSABLE: tuple[frozenset[str], ...] = (
    frozenset({"white", "silver"}),
    frozenset({"silver", "grey"}),
    frozenset({"white", "grey"}),
    frozenset({"grey", "black"}),
    frozenset({"blue", "black"}),  # dark blue reads black
    frozenset({"green", "black"}),  # bottle green reads black
    frozenset({"brown", "red"}),
    frozenset({"red", "orange"}),
    frozenset({"orange", "yellow"}),
    frozenset({"yellow", "white"}),  # pale yellow under sodium light
    frozenset({"brown", "grey"}),
)


def colour_word(text: str | None) -> str | None:
    """Free-form colour text -> one of our colour words, or None.

    VAHAN colours arrive as things like 'PEARL WHITE', 'SILVER/GREY' or
    'BLUE MET.'. The first word we recognise wins, which is right: 'PEARL WHITE'
    is white, and a two-tone 'SILVER/GREY' is a neutral either way.
    """
    if not text:
        return None
    s = str(text).lower()
    for word, canon in _COLOUR_WORDS.items():
        if word in s:
            return canon
    return None


def colour_mismatch(
    observed: str | None,
    registered: str | None,
    *,
    night: bool = False,
    ir: bool = False,
) -> dict | None:
    """Observed body colour vs the registered colour. None when they agree, are
    confusable, are unknown, or the scene was too dark to judge."""
    if night or ir:
        return None
    obs = colour_word(observed)
    reg = colour_word(registered)
    if obs is None or reg is None or obs == reg:
        return None
    if frozenset({obs, reg}) in _COLOUR_CONFUSABLE:
        return None
    return {
        "observed": obs,
        "registered": reg,
        "strength": "weak",
        "reason": f"plate is registered to a {reg} vehicle but the camera saw a {obs} one — "
        f"possible cloned plate, or the vehicle was repainted and the registry "
        f"not updated; a lead for an officer, not a verdict",
    }


if __name__ == "__main__":  # self-test
    assert from_detector(3) == "motorcycle" and from_detector("bike") == "motorcycle"
    assert from_detector("autorickshaw") == "autorickshaw" and from_detector("bicycle") is None
    assert from_vahan("Motor Cycle") == "motorcycle" and from_vahan("3WN") == "autorickshaw"
    assert (
        from_vahan("LMV") == "car"
        and from_vahan("Goods Carrier") == "truck"
        and from_vahan("E-Rickshaw(P)") == "erickshaw"
    )
    assert (
        compatible("bike", "motorcycle")
        and compatible("car", "vehicle")
        and not compatible("motorcycle", "truck")
    )
    assert registry_mismatch("autorickshaw", "Motor Cycle") is not None
    assert registry_mismatch("car", "3WN") is None  # COCO calls autos cars — soft
    assert registry_mismatch("motorcycle", "LMV") is not None
    names = {0: "car", 1: "motorcycle", 2: "autorickshaw", 3: "bus", 4: "truck", 5: "vehicle", 6: "bicycle"}
    assert trackable_ids(names) == [0, 1, 2, 3, 4, 5]
    print("vehicle_types self-test OK")
