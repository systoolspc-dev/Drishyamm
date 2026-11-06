"""plate_rules: validation and correction stay separate; the tables are data.

Every expectation here was recorded from the module on 2026-09-02 BEFORE the
tables moved to plate_formats.json, so the JSON-backed tables are provably a
pure refactor — plus the one intended change: Telangana's TG series (issued
since 2024) validates instead of being rejected as a fake state.

Run inside the worker container from the anpr_worker folder:
    python -m pytest tests/test_plate_rules.py -q
"""

from __future__ import annotations

import json
import logging
import os
import sys
from collections import Counter

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # anpr_worker/
if ROOT not in sys.path:  # conftest.py does this too; harmless twice
    sys.path.insert(0, ROOT)

import plate_rules as pr  # noqa: E402

SHIPPED = os.path.join(ROOT, "plate_formats.json")
# The AI service imports its own copy of both files. Inside the worker
# container that tree is not mounted, so the identity check runs only where
# the second copy is visible (the host); `cmp` on the host does the same.
VMS_FACE = os.path.join(ROOT, "..", "ai_service", "vms_face", "services")

STATE_CODES_2026_09_02 = {
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
}


def shipped() -> dict:
    with open(SHIPPED, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture
def formats_env(monkeypatch):
    """Whatever a test loads, the shipped tables are back afterwards — they are
    module state shared by every other test."""
    monkeypatch.delenv("ANPR_PLATE_FORMATS", raising=False)
    yield monkeypatch
    monkeypatch.undo()
    pr.load_formats()


# ── validation (never rewrites) ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "GJ01AB1234",
        "MH03DY5705",  # standard SS DD LL NNNN
        "GJ01A1234",
        "GJ1A1234",  # single-letter series, 2- and 1-digit district
        "MH12ABC1234",  # 3-letter series (11 chars)
        "DL8CAF1234",
        "DL8AB1234",  # 1-digit district (Delhi)
        "DD023845",
        "MH031234",  # no-series SS DD NNNN (needs the 2-digit district)
        "22BH1234AA",
        "23BH6826J",  # Bharat series, 2- and 1-letter suffix
        "TS09AB1234",
        "TG09AB1234",  # Telangana: TS (2014-2024) and TG (since 2024)
        "OR02AB1234",
        "UA07AB1234",  # old codes stay valid: the old fleet is on the road
        "gj01ab1234",
        "GJ-01-AB-1234",
        "GJ01 AB 1234",  # cleaned first: case, dashes, spaces
        "GJ0ZBP5367",  # pinned: 1-digit district + 3-letter series is a legal SHAPE
    ],
)
def test_valid_plates(text):
    assert pr.is_valid_plate(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "MARUTI",
        "",
        "ZZ01AB1234",
        "XX023845",  # not a plate / fake state
        "KA54339",  # 7 chars: no-series shape needs the 2-digit district
        "GJ01AB123",
        "GJ01AB12345",  # 3 / 5 digits in the number
        "22BH1234",
        "238H6826J",  # Bharat series needs a suffix / the literal BH
        "MH03DYS7O5",
        "WH03DY5705",  # near-misses are NOT valid — correction is a separate step
    ],
)
def test_invalid_plates(text):
    assert pr.is_valid_plate(text) is False


def test_tg_series_is_now_valid():
    """The audit's false rejection: TG plates were rejected as a fake state."""
    assert pr.is_valid_plate("TG09AB1234")
    assert pr.template_of("TG09AB1234") == "LLDDLLDDDD"
    assert pr.code_of("TG09AB1234") == "TG09"
    assert pr.validate_or_correct("TG09AB1234") == "TG09AB1234"
    assert pr.correct_plate("T609AB1234") == "TG09AB1234"  # 6↔G confusion of a TG plate now salvageable
    assert pr.is_valid_plate("TS09AB1234")  # the older series stays valid


def test_validation_and_correction_are_separate():
    assert pr.is_valid_plate("MH03DYS7O5") is False
    assert pr.validate_or_correct("MH03DYS7O5") == "MH03DY5705"
    assert pr.correct_plate("GJ01AB1234") == "GJ01AB1234"  # a valid read passes through untouched
    assert pr.is_bh_plate("22BH1234AA") and not pr.is_bh_plate("GJ01AB1234")


# ── correction ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("MH03DYS7O5", "MH03DY5705"),  # S→5 and O→0 in digit slots
        ("MH03DYS705", "MH03DY5705"),
        ("WH03DY5705", "MH03DY5705"),  # whole-state-code fix
        ("NH03DY5705", "MH03DY5705"),
        ("6J01AB1234", "GJ01AB1234"),
        ("KL07AB12O5", "KL07AB1205"),
        ("0L8CAF1234", "DL8CAF1234"),  # 0L → DL then the 1-digit-district template
        ("22BH12S4AA", "22BH1254AA"),  # Bharat series digit slot
        ("2ZBH1234A", "22BH1234A"),
        ("238H6826J", "23BH6826J"),  # 8 → the fixed H literal
        ("MH03D5705", "MH03D5705"),  # already valid (single-letter series)
        (
            "GJ0ZBP5367",
            "GJ0ZBP5367",
        ),  # pinned: valid shape, so untouched here — the decoder's template prior prefers GJ02BP5367
        ("GJ3ZV0453", "GJ3ZV0453"),  # pinned, same reason
        ("MHO8C6000", "MH0BC6000"),  # pinned: the first 9-char template (LLDLLDDDD) fits, so 8→B not O→0
        ("MARUTI", None),
        ("GJ01ABX234", None),  # X cannot become a digit
        ("GJ01AB12E4", None),
        ("ZZ01AB1234", None),  # fake state, nothing to fix it to
        ("", None),
    ],
)
def test_correct_plate(text, expected):
    assert pr.correct_plate(text) == expected
    assert pr.validate_or_correct(text) == expected


@pytest.mark.parametrize(
    "p,tpl,expected",
    [
        ("GJ0ZBP5367", "LLDDLLDDDD", "GJ02BP5367"),
        ("MH03DYS7O5", "LLDDLLDDDD", "MH03DY5705"),
        ("238H6826J", "DDBHDDDDL", "23BH6826J"),
        ("22BH12S4AA", "DDBHDDDDLL", "22BH1254AA"),
        ("0L8CAF1234", "LLDLLLDDDD", "OL8CAF1234"),  # template alone; the state fix is correct_plate's job
        ("GJ01ABX234", "LLDDLLDDDD", None),
        ("GJ01AB1234", "LLDDLLDDD", None),  # length mismatch
    ],
)
def test_apply_template(p, tpl, expected):
    assert pr.apply_template(p, tpl) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("GJ01AB1234", "LLDDLLDDDD"),
        ("22BH1234AA", "DDBHDDDDLL"),
        ("23BH6826J", "DDBHDDDDL"),
        ("DL8CAF1234", "LLDLLLDDDD"),
        ("DL8AB1234", "LLDLLDDDD"),
        ("DD023845", "LLDDDDDD"),
        ("GJ1A1234", "LLDLDDDD"),
        ("GJ01A1234", "LLDDLDDDD"),
        ("MH12ABC1234", "LLDDLLLDDDD"),
        ("gj01ab1234", "LLDDLLDDDD"),
        ("MARUTI", None),
        ("ZZ01AB1234", None),
    ],
)
def test_template_of(text, expected):
    assert pr.template_of(text) == expected


# ── distances / near match / codes ───────────────────────────────────────────


def test_hamming_and_levenshtein():
    assert pr.hamming("ABC", "ABD") == 1
    assert pr.hamming("GJ01AB1234", "GJ01AB1234") == 0
    assert pr.hamming("AB", "ABC") == 99  # different lengths: "infinite"
    assert pr.levenshtein("GJ01AB1234", "GJ01AB124") == 1
    assert pr.levenshtein("", "ABC") == 3 and pr.levenshtein("ABC", "") == 3
    assert pr.levenshtein("kitten", "sitting") == 3
    assert pr.levenshtein("same", "same") == 0


def test_near_match():
    watch = ["GJ01AB1234", "GJ05CD5678"]
    assert pr.near_match("GJ01AB1Z34", watch) == ("GJ01AB1234", 1)  # one char off: a lead
    assert pr.near_match("GJ05CD5678", watch) == ("GJ05CD5678", 0)  # exact
    assert pr.near_match("GJ01AB124", watch) == ("GJ01AB1234", 1)  # one char short: levenshtein
    assert pr.near_match("MH12XY9999", watch) == (None, None)
    assert pr.near_match("GJ01AB1Z3Z", ["GJ01AB1234"]) == (None, None)
    assert pr.near_match("GJ01AB1Z3Z", ["GJ01AB1234"], max_distance=2) == ("GJ01AB1234", 2)
    assert pr.near_match("GJ01AB1234", []) == (None, None)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("GJ01AB1234", "GJ01"),
        ("gj01ab1234", "GJ01"),
        ("DD023845", "DD02"),
        ("TG09AB1234", "TG09"),
        ("DL8CAF1234", "DL8"),
        ("GJ0ZBP5367", "GJ0"),
        ("22BH1234AA", None),
        ("ZZ01AB1234", None),
        ("GJ", None),
        ("MARUTI", None),
    ],
)
def test_code_of(text, expected):
    assert pr.code_of(text) == expected


def test_code_log_prior():
    assert pr.code_log_prior(Counter({"GJ01": 3})) is None  # too little evidence
    lp = pr.code_log_prior(Counter({"GJ01": 30, "GJ05": 10, "DL8": 1}))
    assert set(lp) == {"GJ01", "GJ05", "DL8", "__other__"}
    assert lp["GJ01"] > lp["GJ05"] > lp["DL8"] >= lp["__other__"]
    assert lp["GJ01"] == pytest.approx(1.0428, abs=1e-3) and lp["__other__"] == -2.0  # clipped
    assert all(-2.0 <= v <= 2.0 for v in lp.values())
    lp1 = pr.code_log_prior(Counter({"GJ01": 1000}), clip=1.0)
    assert lp1 == {"GJ01": pytest.approx(0.6926, abs=1e-3), "__other__": -1.0}


# ── the tables: data, pinned to today's values ───────────────────────────────


def test_regexes_unchanged():
    assert pr.PLATE_RE.pattern == r"^(?:[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}|[A-Z]{2}[0-9]{2}[0-9]{4})$"
    assert pr.BH_RE.pattern == r"^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$"


def test_tables_pinned_to_2026_09_02_values():
    """Byte-for-byte the tables the module carried in code, plus TG."""
    assert isinstance(pr.STATE_CODES, set) and pr.STATE_CODES == STATE_CODES_2026_09_02
    assert pr.TEMPLATES == {
        8: ["LLDLDDDD", "LLDDDDDD"],
        9: ["LLDLLDDDD", "LLDDLDDDD", "DDBHDDDDL"],
        10: ["LLDDLLDDDD", "DDBHDDDDLL", "LLDLLLDDDD"],
        11: ["LLDDLLLDDDD"],
    }
    assert all(isinstance(k, int) for k in pr.TEMPLATES)
    assert pr.TEMPLATE_PRIOR == {
        "LLDDLLDDDD": 0.0,
        "LLDDLDDDD": -0.7,
        "DDBHDDDDLL": -1.2,
        "DDBHDDDDL": -1.5,
        "LLDLLDDDD": -1.5,
        "LLDDDDDD": -2.0,
        "LLDLLLDDDD": -2.5,
        "LLDLDDDD": -2.5,
        "LLDDLLLDDDD": -1.5,
    }
    assert set(pr.TEMPLATE_PRIOR) == {t for ts in pr.TEMPLATES.values() for t in ts}
    assert pr.TWO_DIGIT_DISTRICT_STATES == {
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
    }
    assert pr.TO_DIGIT == {
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
    }
    assert pr.TO_LETTER == {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "4": "A", "7": "T"}
    assert pr.STATE_FIX == {
        "WH": "MH",
        "NH": "MH",
        "0L": "DL",
        "0D": "OD",
        "HH": "MH",
        "6J": "GJ",
        "CJ": "GJ",
        "GU": "GJ",
    }
    assert pr.ONE_DIGIT_DISTRICT_PENALTY == -5.0 and isinstance(pr.ONE_DIGIT_DISTRICT_PENALTY, float)
    assert pr.CODE_PRIOR_WEIGHT == 1.0 and isinstance(pr.CODE_PRIOR_WEIGHT, float)


def test_shipped_file_matches_builtin_defaults():
    """plate_formats.json and _DEFAULTS never drift: the fallback IS the file."""
    raw = shipped()
    assert "TG" in raw["state_codes"] and "TS" in raw["state_codes"]
    fmt = pr._normalise(raw)
    for key in pr._TABLE_KEYS:
        assert fmt[key] == pr._DEFAULTS[key], key
    assert fmt["version"] == pr._DEFAULTS["version"] == raw["version"]


def test_describe_reports_the_shipped_file():
    d = pr.describe()
    assert d == {"version": "2026-09-02", "states": 40, "templates": 9, "source": os.path.abspath(SHIPPED)}
    assert pr.FORMATS_VERSION == "2026-09-02"


# ── load_formats: the configurable layer ─────────────────────────────────────


def test_load_formats_env_round_trip(formats_env, tmp_path):
    """A state code exists only while the file that carries it is loaded."""
    raw = shipped()
    raw["state_codes"].append("ZZ")
    raw["version"] = "test-zz"
    custom = tmp_path / "formats.json"
    custom.write_text(json.dumps(raw), encoding="utf-8")
    codes = pr.STATE_CODES  # the object importers hold
    assert not pr.is_valid_plate("ZZ01AB1234")

    formats_env.setenv("ANPR_PLATE_FORMATS", str(custom))
    fmt = pr.load_formats()
    assert pr.is_valid_plate("ZZ01AB1234") and pr.code_of("ZZ01AB1234") == "ZZ01"
    assert pr.is_valid_plate("GJ01AB1234") and not pr.is_valid_plate("QQ01AB1234")
    assert fmt["source"] == os.path.abspath(str(custom)) and "ZZ" in fmt["state_codes"]
    assert pr.describe() == {
        "version": "test-zz",
        "states": 41,
        "templates": 9,
        "source": os.path.abspath(str(custom)),
    }
    assert "ZZ" in codes and codes is pr.STATE_CODES  # updated in place, not rebound

    formats_env.delenv("ANPR_PLATE_FORMATS")
    pr.load_formats()
    assert not pr.is_valid_plate("ZZ01AB1234")
    assert pr.describe()["source"] == os.path.abspath(SHIPPED) and pr.FORMATS_VERSION == "2026-09-02"


def test_load_formats_explicit_path_and_partial_file(formats_env, tmp_path):
    """A file may carry only the keys it changes; the rest keep the built-ins."""
    custom = tmp_path / "only_states.json"
    custom.write_text(json.dumps({"version": "partial", "state_codes": ["GJ", "ZZ"]}), encoding="utf-8")
    fmt = pr.load_formats(str(custom))
    assert pr.STATE_CODES == {"GJ", "ZZ"} and fmt["version"] == "partial"
    assert pr.is_valid_plate("ZZ01AB1234") and not pr.is_valid_plate("MH01AB1234")
    assert pr.TEMPLATES == pr._DEFAULTS["templates"] and pr.TO_DIGIT == pr._DEFAULTS["to_digit"]
    assert pr.ONE_DIGIT_DISTRICT_PENALTY == -5.0 and pr.CODE_PRIOR_WEIGHT == 1.0


@pytest.mark.parametrize(
    "bad",
    [
        {"state_codes": "GJ"},  # wrong shape
        {"state_codes": ["GJ", "gj"]},  # not upper-case
        {"state_code": ["GJ"]},  # typo'd key
        {"templates": {"9": ["LLDDLLDDDD"]}},  # length mismatch
        {"templates": {"10": ["LLDDLLDDDX"]}},  # not an L/D/B/H slot
        {"template_prior": {"LLDDLLDDDD": "0"}},  # not a number
        {"to_digit": {"OO": "0"}},  # not single characters
        {"one_digit_district_penalty": True},
        "[not an object]",
    ],
)
def test_invalid_file_is_skipped_whole_with_one_warning(formats_env, tmp_path, caplog, bad):
    custom = tmp_path / "bad.json"
    custom.write_text(bad if isinstance(bad, str) else json.dumps(bad), encoding="utf-8")
    formats_env.setenv("ANPR_PLATE_FORMATS", str(custom))
    with caplog.at_level(logging.WARNING, logger="plate_rules"):
        pr.load_formats()
    assert any("ignoring" in r.getMessage() for r in caplog.records)
    assert pr.describe()["source"] == os.path.abspath(SHIPPED)  # fell through to the shipped file
    assert pr.STATE_CODES == STATE_CODES_2026_09_02 and pr.is_valid_plate("GJ01AB1234")


def test_missing_named_file_warns_and_falls_through(formats_env, tmp_path, caplog):
    formats_env.setenv("ANPR_PLATE_FORMATS", str(tmp_path / "nowhere.json"))
    with caplog.at_level(logging.WARNING, logger="plate_rules"):
        pr.load_formats()
    assert any("not found" in r.getMessage() for r in caplog.records)
    assert pr.describe()["source"] == os.path.abspath(SHIPPED)


def test_builtin_fallback_when_no_file_loads(formats_env, tmp_path, caplog):
    """No file anywhere → _DEFAULTS, silently (absence in the normal search is not an error)."""
    formats_env.setattr(pr, "_HERE", str(tmp_path))
    formats_env.setenv("ANPR_BYTETRACK_DIR", str(tmp_path / "no-such-dir"))
    with caplog.at_level(logging.DEBUG, logger="plate_rules"):
        fmt = pr.load_formats()
    assert not caplog.records
    assert fmt["source"] == "builtin" and pr.describe()["source"] == "builtin"
    assert pr.STATE_CODES == STATE_CODES_2026_09_02 and pr.is_valid_plate("TG09AB1234")
    assert pr.validate_or_correct("MH03DYS7O5") == "MH03DY5705"


def test_bytetrack_dir_fallback_serves_the_vms_face_copy(formats_env, tmp_path):
    """The AI-service copy has no file beside it in some deployments: it finds
    the worker's through ANPR_BYTETRACK_DIR."""
    formats_env.setattr(pr, "_HERE", str(tmp_path))
    formats_env.setenv("ANPR_BYTETRACK_DIR", ROOT)
    assert pr.load_formats()["source"] == os.path.abspath(SHIPPED)


def test_self_test_block_cases_unchanged():
    """The cases the module's __main__ block prints, as it printed them on 2026-09-02."""
    expected = {
        "MH03DY5705": "MH03DY5705",
        "MH03DYS705": "MH03DY5705",
        "MH03DYS7O5": "MH03DY5705",
        "WH03DY5705": "MH03DY5705",
        "MH03D5705": "MH03D5705",
        "MH02EK4082": "MH02EK4082",
        "MARUTI": None,
        "KL07AB12O5": "KL07AB1205",
        "0L8CAF1234": "DL8CAF1234",
        "22BH1234AA": "22BH1234AA",
        "22BH12S4AA": "22BH1254AA",
        "2ZBH1234A": "22BH1234A",
        "GJ1A1234": "GJ1A1234",
        "GJ05CD5678": "GJ05CD5678",
        "TG09AB1234": "TG09AB1234",
    }
    assert {t: pr.validate_or_correct(t) for t in expected} == expected
    assert pr.near_match("GJ01AB1Z34", ["GJ01AB1234", "GJ05CD5678"]) == ("GJ01AB1234", 1)


# ── the two copies ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["plate_rules.py", "plate_formats.json"])
def test_worker_and_ai_service_copies_are_identical(name):
    other = os.path.join(VMS_FACE, name)
    if not os.path.exists(other):
        pytest.skip(f"{other} not visible here (not mounted in the worker container) — run `cmp` on the host")
    with open(os.path.join(ROOT, name), "rb") as a, open(other, "rb") as b:
        assert a.read() == b.read(), f"{name}: the anpr_worker and vms_face copies differ"
