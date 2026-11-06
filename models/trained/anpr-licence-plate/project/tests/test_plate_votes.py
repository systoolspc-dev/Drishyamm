"""plate_votes: the character vote, raw-read preservation and the
superstring (length-ambiguity) helpers — pure, no models."""

import pytest

from plate_votes import Consensus, Read, TrackVotes, lookalike_norm, one_insertion


def _read(text: str, weight: float = 0.9, corrected: str | None = None, p: float = 0.9) -> Read:
    """A valid read whose vote text is `corrected` (defaults to the raw text)."""
    return Read(text, [p] * len(text), weight, "base", valid=True, corrected=corrected or text)


# ── (a) the column vote ──────────────────────────────────────────────────────
def test_five_noisy_frames_recover_the_plate():
    frames = ["GJ01AB1Z34", "GJ0IAB1234", "GJ01A81234", "GJ01AB12S4", "CJ01AB1234"]
    tv = TrackVotes()
    for i, t in enumerate(frames):
        tv.add_frame(i, [Read(t, [0.9] * len(t), 0.9, "base")])
    c = tv.consensus()
    assert c.text == "GJ01AB1234"
    assert c.n_frames == 5 and tv.reads == 5
    assert c.agreement == pytest.approx(0.9)  # five columns unanimous, five at 4/5
    assert c.top_whole[0] in frames  # no single frame read the truth
    assert c.longer is None  # nothing one character longer was ever read


# ── (b) raw preservation ─────────────────────────────────────────────────────
def test_raw_text_is_the_uncorrected_read():
    tv = TrackVotes()
    tv.add_frame(0, [_read("GJ01AB1Z34", 0.9, corrected="GJ01AB1234")])  # Z→2 fixed by the rules
    tv.add_frame(1, [_read("GJ01AB1234", 0.5)])
    c = tv.consensus()
    assert c.text == "GJ01AB1234"
    assert c.top_whole[0] == "GJ01AB1234"  # the VOTE text is the corrected one (unchanged behaviour)
    assert c.raw_text == "GJ01AB1Z34"  # …the raw tally keeps what the OCR output
    assert c.raw_text != c.top_whole[0]
    assert c.raw_alternatives == [("GJ01AB1234", 0.5)]
    s = tv.summary()
    assert s["raw"] == "GJ01AB1Z34" and s["consensus"] == "GJ01AB1234"
    assert s["raw_top"][0][0] == "GJ01AB1Z34" and s["longer"] is None


def test_single_corrected_read_keeps_raw():
    tv = TrackVotes()
    tv.add_frame(0, [_read("GJ01AB1Z34", corrected="GJ01AB1234")])
    c = tv.consensus()
    assert (c.text, c.raw_text) == ("GJ01AB1234", "GJ01AB1Z34")
    assert c.raw_alternatives == []


def test_consensus_dataclass_defaults_stay_backward_compatible():
    c = Consensus("GJ01AB1234", 1.0, 1.0, 1, 0.9, ("GJ01AB1234", 1.0))
    assert c.raw_text == "" and c.raw_alternatives == [] and c.longer is None
    assert 0 < c.confidence(3) <= 1.0


# ── (c) look-alike normalisation + one insertion ─────────────────────────────
def test_lookalike_norm_classes():
    assert lookalike_norm("0OQD") == "0000"
    assert lookalike_norm("1IL") == "111"
    assert lookalike_norm("2Z5S8B") == "225588"
    assert lookalike_norm("6GCE4A7T") == "66664477"
    assert lookalike_norm("gj01ab") == "6J0148"  # upper-cased first, then G→6, A→4, B→8
    assert lookalike_norm("GJ01AB1234") == "6J01481234"
    assert lookalike_norm("") == "" and lookalike_norm(None) == ""


@pytest.mark.parametrize(
    "short,long,expected",
    [
        # the six wrong 9-char posted reads of the 2026-09-02 audit and the 10-char read that was right
        ("GJ11C1758", "GJ11CL7580", True),
        ("GJ27E6741", "GJ27EC7416", True),
        ("GJ01R5592", "GJ01RS5926", True),
        ("GJ24A4516", "GJ24AA5169", True),
        ("GJ18B8744", "GJ18BB7442", True),
        ("GJ18E4884", "GJ18EA8844", True),
        ("GJ08F1957", "GJ08FA9678", False),  # a shifted read: several characters differ
        ("GJ01AB1234", "GJ01AB1234", False),  # same length is not an insertion
        ("GJ01AB1234", "GJ01ABC12345", False),  # two characters longer
        ("GJ01AB123", "GJ01AB1234", True),  # dropped last char
        ("J01AB1234", "GJ01AB1234", True),  # dropped first char
        ("GJ01AB1234", "GJ01AB123", False),  # the other way round is not an insertion
        ("", "A", False),
    ],
)
def test_one_insertion(short, long, expected):
    assert one_insertion(short, long) is expected


def test_one_insertion_is_lookalike_aware():
    assert one_insertion("GJ11C1758", "GJ11CL758O")  # 0 read as O still counts as the same glyph
    assert one_insertion("GJ11CI758", "GJ11CL7580")  # 1/I/L are one class


# ── Consensus.longer ─────────────────────────────────────────────────────────
def test_longer_reports_the_valid_superstring_the_buckets_outvoted():
    tv = TrackVotes()
    for i in range(3):
        tv.add_frame(i, [_read("GJ11C1758", 0.8)])
    tv.add_frame(3, [_read("GJ11CL7580", 0.43)])
    c = tv.consensus()
    assert c.text == "GJ11C1758"  # the 9-char bucket wins on total weight (2.4 vs 0.43)
    assert c.weight == pytest.approx(2.4)
    assert c.longer == ("GJ11CL7580", 0.43)
    assert tv.summary()["longer"] == ("GJ11CL7580", 0.43)


def test_longer_ignores_invalid_or_shifted_reads():
    tv = TrackVotes()
    for i in range(3):
        tv.add_frame(i, [_read("GJ11C1758", 0.8)])
    tv.add_frame(
        3, [Read("GJ11CL758O", [0.9] * 10, 0.43, "base", valid=False, corrected=None)]
    )  # O in a digit slot
    assert tv.consensus().longer is None
    tv = TrackVotes()
    for i in range(3):
        tv.add_frame(i, [_read("GJ08F1957", 0.8)])
    tv.add_frame(3, [_read("GJ08FA9678", 0.43)])
    assert tv.consensus().longer is None


def test_longer_picks_the_heaviest_candidate():
    tv = TrackVotes()
    for i in range(3):
        tv.add_frame(i, [_read("GJ11C1758", 0.8)])
    tv.add_frame(3, [_read("GJ11CL7580", 0.2)])
    tv.add_frame(4, [_read("GJ11CI7580", 0.5)])  # also valid, also one insertion (I≡L≡1), heavier
    assert tv.consensus().longer == ("GJ11CI7580", 0.5)


def test_no_longer_when_the_long_bucket_wins_itself():
    tv = TrackVotes()
    tv.add_frame(0, [_read("GJ11C1758", 0.3)])
    for i in range(1, 4):
        tv.add_frame(i, [_read("GJ11CL7580", 0.8)])
    c = tv.consensus()
    assert c.text == "GJ11CL7580" and c.longer is None
