"""
plate_rules.py  —  Indian license-plate domain rules.

Uses the KNOWN STRUCTURE of Indian plates to validate and CORRECT OCR reads.

Standard series:   SS DD  L(1-3)  NNNN
                   SS   = 2-letter state/UT code (must be a real one)
                   DD   = 1-2 digit RTO district code
                   L    = 1-3 letter series
                   NNNN = 4-digit unique number  (ALWAYS digits — never letters)
Bharat series:     YY BH NNNN L(1-2)          e.g. 22BH1234AA  (since 2021)

Templates (L = letter slot, D = digit slot) per string length — these are the
position priors the constrained decoder in plate_ocr.py multiplies the OCR
distribution by (ĉ_i = argmax_c p_OCR(c|x)·p_format(c|i)):

    8  : LLDLDDDD  LLDDDDDD             GJ1A1234 (old single-letter series), DD023845 (no series)
    9  : LLDLLDDDD  LLDDLDDDD  DDLLDDDDL
    10 : LLDDLLDDDD DDLLDDDDLL LLDLLLDDDD
    11 : LLDDLLLDDDD

Two things rules CAN do:
  1. Reject impossible reads (fake state code, letters where digits must be).
  2. Auto-correct common OCR confusions IN THE RIGHT POSITION
     (O<->0, I<->1, S<->5, etc.) then re-check.
What rules CANNOT do: decide between two reads that are BOTH valid
(e.g. MH03DY5705 vs MH03DZ5705) — that still needs voting.

The TABLES are data, not code (2026-09-02): state codes, templates, priors
and confusion maps come from plate_formats.json beside this file (or
$ANPR_PLATE_FORMATS), so a new registration series — Telangana's "TG",
issued since 2024 and rejected as a fake state until then — is a JSON edit,
not a release. `_DEFAULTS` below is the same table built in, for when no
file loads. Validation (is_valid_plate) and correction (validate_or_correct)
stay separate functions: nothing here rewrites a read silently.
"""

import json
import logging
import math
import os
import re

_log = logging.getLogger(__name__)
_HERE = os.path.dirname(os.path.abspath(__file__))
FORMATS_FILENAME = "plate_formats.json"

# Built-in copy of plate_formats.json: the fallback when no file loads, and
# what the shipped file is tested against so the two never drift.
_DEFAULTS = {
    "version": "2026-09-02",
    # Every valid Indian state / UT registration code. Old and new codes both
    # stay valid (OR/OD, UA/UK, TS/TG): the old fleet is still on the road.
    # TG = Telangana's series since 2024 (missing until 2026-09-02, so every
    # TG plate was rejected as a fake state); TS kept for 2014-2024 plates.
    "state_codes": {
        "AP",
        "AR",
        "AS",
        "BR",
        "CG",
        "GA",
        "GJ",
        "HR",
        "HP",
        "JH",
        "JK",
        "KA",
        "KL",
        "MP",
        "MH",
        "MN",
        "ML",
        "MZ",
        "NL",
        "OD",
        "OR",
        "PB",
        "RJ",
        "SK",
        "TN",
        "TS",
        "TG",
        "TR",
        "UP",
        "UK",
        "UA",
        "WB",
        "AN",
        "CH",
        "DN",
        "DD",
        "DL",
        "LD",
        "PY",
        "LA",
    },
    # Position templates per length, most common first. 'L' letter, 'D' digit,
    # 'B'/'H' fixed literal (Bharat series).
    "templates": {
        # (no 7-char template: SS D NNNN registrations are rare enough that the
        # template mostly legitimised OCR noise — seen live as "KA54339")
        8: ["LLDLDDDD", "LLDDDDDD"],
        9: ["LLDLLDDDD", "LLDDLDDDD", "DDBHDDDDL"],
        10: ["LLDDLLDDDD", "DDBHDDDDLL", "LLDLLLDDDD"],
        11: ["LLDDLLLDDDD"],
    },
    # Log-prior per template = how common that plate SHAPE is on Indian roads.
    # The constrained decoder adds it to the OCR log-prob, so a rare shape that
    # happens to fit the raw glyphs no longer beats the common shape that needs
    # one confusion fix (seen live: "GJ0ZBP5367" chosen over "GJ02BP5367").
    "template_prior": {
        "LLDDLLDDDD": 0.0,  # GJ01AB1234 — the standard plate
        "LLDDLDDDD": -0.7,  # GJ01A1234  — single-letter series (older)
        "DDBHDDDDLL": -1.2,  # 22BH1234AB — Bharat series
        "DDBHDDDDL": -1.5,  # 22BH1234A
        "LLDLLDDDD": -1.5,  # DL8AB1234  — 1-digit district (Delhi etc.)
        "LLDDDDDD": -2.0,  # DD023845   — no series letters (old)
        "LLDLLLDDDD": -2.5,  # DL8CAF1234 — 1-digit district + 3 letters
        "LLDLDDDD": -2.5,  # GJ1A1234
        "LLDDLLLDDDD": -1.5,  # MH12ABC1234 — 3-letter series
    },
    # States whose RTO codes are ALWAYS two digits: a 1-digit-district template
    # is almost certainly a misread there (extra penalty).
    "two_digit_district_states": {
        "GJ",
        "MH",
        "RJ",
        "MP",
        "KA",
        "TN",
        "UP",
        "HR",
        "PB",
        "AP",
        "TS",
        "TG",
        "KL",
        "WB",
        "BR",
        "OD",
        "CG",
        "JH",
        "UK",
        "HP",
        "AS",
    },
    # OCR confusions. Two maps because the fix depends on POSITION:
    # in a LETTER slot a '0' should become 'O'; in a DIGIT slot an 'O' -> '0'.
    "to_digit": {
        "O": "0",
        "Q": "0",
        "D": "0",
        "I": "1",
        "L": "1",
        "Z": "2",
        "S": "5",
        "B": "8",
        "G": "6",
        "T": "7",
        "A": "4",
    },
    "to_letter": {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "4": "A", "7": "T"},
    # common whole-state-code fixes (first char misread)
    "state_fix": {
        "WH": "MH",
        "NH": "MH",
        "0L": "DL",
        "0D": "OD",
        "HH": "MH",
        "6J": "GJ",
        "CJ": "GJ",
        "GU": "GJ",
    },
    # Strong: these states never issue 1-digit district codes, so "GJ3ZV0453" is a
    # Z↔2 confusion of GJ32V0453, not a plate. -5 outweighs a 0.96-vs-0.01
    # glyph probability gap; the raw read survives as an alternative regardless.
    "one_digit_district_penalty": -5.0,
    # Weight of the PER-CAMERA registration-code prior (state+district histogram
    # of confirmed plates on that camera) inside the constrained decode.
    "code_prior_weight": 1.0,
}
_TABLE_KEYS = (
    "state_codes",
    "templates",
    "template_prior",
    "two_digit_district_states",
    "to_digit",
    "to_letter",
    "state_fix",
    "one_digit_district_penalty",
    "code_prior_weight",
)

# Full standard plate: SS DD L(1-3) NNNN, or the older no-series shape
# SS DD NNNN (e.g. DD02 3845, seen live) — which needs the 2-digit district,
# otherwise 7-char OCR noise like "KA54339" would validate.
# Bharat series: YY BH NNNN L(1-2)
# The SHAPE of an Indian plate is not configuration: these two stay in code.
# The state-code check is separate (is_valid_plate), so a new series is a
# plate_formats.json edit.
PLATE_RE = re.compile(r"^(?:[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}|[A-Z]{2}[0-9]{2}[0-9]{4})$")
BH_RE = re.compile(r"^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$")

# The live tables. load_formats() fills them at import (from the JSON, else
# _DEFAULTS) and mutates them IN PLACE on a reload, so a `from plate_rules
# import STATE_CODES` elsewhere (plate_ocr.py, worker.py, synth_plates.py)
# keeps seeing the current values. The two scalars are rebound here only.
STATE_CODES = set()
TEMPLATES = {}
TEMPLATE_PRIOR = {}
TWO_DIGIT_DISTRICT_STATES = set()
TO_DIGIT = {}
TO_LETTER = {}
STATE_FIX = {}
ONE_DIGIT_DISTRICT_PENALTY = _DEFAULTS["one_digit_district_penalty"]
CODE_PRIOR_WEIGHT = _DEFAULTS["code_prior_weight"]
FORMATS_VERSION = _DEFAULTS["version"]
FORMATS_SOURCE = "builtin"  # path the tables came from, or "builtin"


def _normalise(raw):
    """JSON shapes → the module's shapes, checked. A key missing from `raw`
    keeps the built-in table; a wrong shape raises ValueError and the file is
    skipped as a whole — a half-applied format table is worse than none."""
    if not isinstance(raw, dict):
        raise ValueError("top level must be an object")
    unknown = sorted(set(raw) - set(_TABLE_KEYS) - {"version", "notes", "$schema"})
    if unknown:
        raise ValueError(f"unknown keys {unknown}")
    fmt = {"version": str(raw.get("version", _DEFAULTS["version"]))}

    def two_letter_set(key):
        vals = raw.get(key)
        if vals is None:
            return set(_DEFAULTS[key])
        if not isinstance(vals, list) or not all(
            isinstance(v, str) and len(v) == 2 and v.isalpha() and v.isupper() for v in vals
        ):
            raise ValueError(f"{key}: expected a list of 2-letter upper-case codes")
        return set(vals)

    def char_map(key, n):
        vals = raw.get(key)
        if vals is None:
            return dict(_DEFAULTS[key])
        if not isinstance(vals, dict) or not all(
            isinstance(k, str) and isinstance(v, str) and len(k) == n and len(v) == n for k, v in vals.items()
        ):
            raise ValueError(f"{key}: expected an object of {n}-character strings")
        return dict(vals)

    def number(key):
        v = raw.get(key)
        if v is None:
            return float(_DEFAULTS[key])
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{key}: expected a number")
        return float(v)

    fmt["state_codes"] = two_letter_set("state_codes")
    fmt["two_digit_district_states"] = two_letter_set("two_digit_district_states")
    tpls = raw.get("templates")
    if tpls is None:
        fmt["templates"] = {n: list(t) for n, t in _DEFAULTS["templates"].items()}
    else:
        if not isinstance(tpls, dict):
            raise ValueError("templates: expected an object keyed by plate length")
        out = {}
        for n, lst in tpls.items():
            if not str(n).isdigit() or not isinstance(lst, list):
                raise ValueError(f"templates[{n!r}]: expected a length key and a list of templates")
            n = int(n)
            for t in lst:
                if not isinstance(t, str) or len(t) != n or set(t) - set("LDBH"):
                    raise ValueError(f"templates[{n}]: {t!r} is not a {n}-slot L/D/B/H template")
            out[n] = list(lst)
        fmt["templates"] = out
    prior = raw.get("template_prior")
    if prior is None:
        fmt["template_prior"] = dict(_DEFAULTS["template_prior"])
    else:
        if not isinstance(prior, dict) or not all(
            isinstance(k, str)
            and not set(k) - set("LDBH")
            and isinstance(v, (int, float))
            and not isinstance(v, bool)
            for k, v in prior.items()
        ):
            raise ValueError("template_prior: expected an object template → number")
        fmt["template_prior"] = {k: float(v) for k, v in prior.items()}
    fmt["to_digit"] = char_map("to_digit", 1)
    fmt["to_letter"] = char_map("to_letter", 1)
    fmt["state_fix"] = char_map("state_fix", 2)
    fmt["one_digit_district_penalty"] = number("one_digit_district_penalty")
    fmt["code_prior_weight"] = number("code_prior_weight")
    return fmt


def _apply(fmt, source):
    global ONE_DIGIT_DISTRICT_PENALTY, CODE_PRIOR_WEIGHT, FORMATS_VERSION, FORMATS_SOURCE
    STATE_CODES.clear()
    STATE_CODES.update(fmt["state_codes"])
    TEMPLATES.clear()
    TEMPLATES.update({n: list(t) for n, t in fmt["templates"].items()})
    TEMPLATE_PRIOR.clear()
    TEMPLATE_PRIOR.update(fmt["template_prior"])
    TWO_DIGIT_DISTRICT_STATES.clear()
    TWO_DIGIT_DISTRICT_STATES.update(fmt["two_digit_district_states"])
    TO_DIGIT.clear()
    TO_DIGIT.update(fmt["to_digit"])
    TO_LETTER.clear()
    TO_LETTER.update(fmt["to_letter"])
    STATE_FIX.clear()
    STATE_FIX.update(fmt["state_fix"])
    ONE_DIGIT_DISTRICT_PENALTY = fmt["one_digit_district_penalty"]
    CODE_PRIOR_WEIGHT = fmt["code_prior_weight"]
    FORMATS_VERSION = fmt["version"]
    FORMATS_SOURCE = source


def _candidates(path=None):
    """Where to look, in order: an explicit path, $ANPR_PLATE_FORMATS, the file
    beside this module, the worker's copy — the vms_face copy of this module
    finds it through $ANPR_BYTETRACK_DIR (/srv/app/anpr_worker in the AI
    container). The first two are named by someone, so their absence is worth
    one warning; the last two are the normal search, silent when absent."""
    named = [p for p in (path, os.getenv("ANPR_PLATE_FORMATS")) if p]
    searched = [
        os.path.join(_HERE, FORMATS_FILENAME),
        os.path.join(os.getenv("ANPR_BYTETRACK_DIR", "/srv/app/anpr_worker"), FORMATS_FILENAME),
    ]
    return [(p, True) for p in named] + [(p, False) for p in searched]


def load_formats(path=None):
    """Load the plate-format tables into this module; returns them as a dict
    (plus "source": the file used, or "builtin").

    Resolution: `path` → $ANPR_PLATE_FORMATS → plate_formats.json beside this
    module → $ANPR_BYTETRACK_DIR/plate_formats.json → the built-in _DEFAULTS.
    A file that exists but is not a valid format table logs one warning and is
    skipped whole; an absent file in the normal search is skipped silently.
    The tables are updated in place (see the note above them)."""
    fmt, source = None, "builtin"
    for cand, named in _candidates(path):
        if not os.path.isfile(cand):
            if named:
                _log.warning("plate_formats: %s not found — trying the next location", cand)
            continue
        try:
            with open(cand, encoding="utf-8") as f:
                fmt = _normalise(json.load(f))
            source = os.path.abspath(cand)
            break
        except (OSError, ValueError, TypeError) as e:
            _log.warning("plate_formats: ignoring %s: %s", cand, e)
    if fmt is None:
        fmt = _normalise({})
    _apply(fmt, source)
    return dict(fmt, source=source)


def describe():
    """What the validator is running on — for a config/health endpoint and the
    tests: {"version", "states", "templates", "source"}."""
    return {
        "version": FORMATS_VERSION,
        "states": len(STATE_CODES),
        "templates": sum(len(v) for v in TEMPLATES.values()),
        "source": FORMATS_SOURCE,
    }


load_formats()


def code_of(plate):
    """Registration code part of a plate: 'GJ01' (2-digit district), 'DL8'
    (1-digit), None for Bharat series / invalid."""
    p = _clean(plate)
    if len(p) < 4 or not p[:2].isalpha() or p[:2] not in STATE_CODES:
        return None
    if p[2:4].isdigit():
        return p[:4]
    if p[2].isdigit():
        return p[:3]
    return None


def code_log_prior(hist, min_total=10, clip=2.0):
    """Counter{code: n} → {code: log-odds vs uniform}, or None if too little
    evidence. '__other__' holds the value for codes never seen here."""
    total = sum(hist.values())
    if total < min_total:
        return None
    k = max(len(hist) + 1, 2)
    base = math.log(1.0 / k)
    out = {c: max(-clip, min(clip, math.log((n + 0.5) / (total + 0.5 * k)) - base)) for c, n in hist.items()}
    out["__other__"] = max(-clip, min(clip, math.log(0.5 / (total + 0.5 * k)) - base))
    return out


def _clean(text):
    return re.sub(r"[^A-Z0-9]", "", str(text).upper())


def is_bh_plate(text):
    return bool(BH_RE.match(_clean(text)))


def is_valid_plate(text):
    """Structurally valid AND real state code (or a Bharat-series plate)."""
    p = _clean(text)
    if BH_RE.match(p):
        return True
    if not PLATE_RE.match(p):
        return False
    return p[:2] in STATE_CODES


def template_of(text):
    """The L/D template a VALID plate follows, else None."""
    p = _clean(text)
    if not is_valid_plate(p):
        return None
    return "".join(
        "B"
        if (i == 2 and p[2:4] == "BH" and p[:2].isdigit())
        else "H"
        if (i == 3 and p[2:4] == "BH" and p[:2].isdigit())
        else ("L" if c.isalpha() else "D")
        for i, c in enumerate(p)
    )


def apply_template(p, tpl):
    """Force `p` onto `tpl` with position-aware confusion maps. None if a slot
    can't be coerced (e.g. 'X' where a digit must be)."""
    if len(p) != len(tpl):
        return None
    out = []
    for c, t in zip(p, tpl):
        if t == "L":
            c2 = c if c.isalpha() else TO_LETTER.get(c)
        elif t == "D":
            c2 = c if c.isdigit() else TO_DIGIT.get(c)
        else:  # fixed literal B / H
            c2 = t if c in (t, TO_LETTER.get(c, ""), {"B": "8", "H": "4"}[t]) else None
        if c2 is None:
            return None
        out.append(c2)
    return "".join(out)


def correct_plate(text):
    """Try to fix a near-miss read using position-aware character rules.
    Returns a corrected valid plate, or None if it can't be salvaged."""
    p = _clean(text)

    # already good?
    if is_valid_plate(p):
        return p

    # obvious whole-state-code fix (e.g. WH -> MH)
    if p[:2] in STATE_FIX:
        p2 = STATE_FIX[p[:2]] + p[2:]
        if is_valid_plate(p2):
            return p2

    # Try every template of this length, most common first.
    for tpl in TEMPLATES.get(len(p), []):
        fixed = apply_template(p, tpl)
        if fixed and is_valid_plate(fixed):
            return fixed
        if fixed and fixed[:2] in STATE_FIX and tpl.startswith("LL"):
            f2 = STATE_FIX[fixed[:2]] + fixed[2:]
            if is_valid_plate(f2):
                return f2
    return None


def validate_or_correct(text):
    """Main entry: return a trustworthy plate string, or None to reject.
    Accepts a valid read as-is, tries to correct a near-miss, else rejects."""
    p = _clean(text)
    if is_valid_plate(p):
        return p
    return correct_plate(p)


def hamming(a, b):
    """Same-length character mismatches (∞ for different lengths)."""
    if len(a) != len(b):
        return 99
    return sum(1 for x, y in zip(a, b) if x != y)


def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def near_match(plate, candidates, max_distance=1):
    """Closest watchlist plate within `max_distance` edits, or (None, None).
    A 1-char-off read of a wanted plate is still a LEAD worth an alert."""
    best, best_d = None, max_distance + 1
    for c in candidates:
        if c == plate:
            return c, 0
        if abs(len(c) - len(plate)) > max_distance:
            continue
        d = hamming(c, plate) if len(c) == len(plate) else levenshtein(c, plate)
        if d < best_d:
            best, best_d = c, d
    return (best, best_d) if best is not None else (None, None)


if __name__ == "__main__":
    tests = [
        "MH03DY5705",
        "MH03DYS705",
        "MH03DYS7O5",
        "WH03DY5705",
        "MH03D5705",
        "MH02EK4082",
        "MARUTI",
        "KL07AB12O5",
        "0L8CAF1234",
        "22BH1234AA",
        "22BH12S4AA",
        "2ZBH1234A",
        "GJ1A1234",
        "GJ05CD5678",
        "TG09AB1234",
    ]
    for t in tests:
        print(f"{t:14} -> {validate_or_correct(t)}   tpl={template_of(validate_or_correct(t) or '')}")
    print(near_match("GJ01AB1Z34", ["GJ01AB1234", "GJ05CD5678"]))
    print(describe())
    # TG: Telangana's series since 2024 — a fake state until the tables became data
    assert is_valid_plate("TG09AB1234") and template_of("TG09AB1234") == "LLDDLLDDDD", "TG must validate"
    assert not is_valid_plate("ZZ09AB1234"), "a fake state must still be rejected"
    assert validate_or_correct("MH03DYS7O5") == "MH03DY5705" and correct_plate("WH03DY5705") == "MH03DY5705"
    print("plate_rules self-test OK")
