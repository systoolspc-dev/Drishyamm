"""plate_enhance._build_within: variants are chosen by prior, then built."""

import numpy as np

import plate_enhance as enh

IMG = np.zeros((4, 4, 3), np.uint8)


def _plan(spec, calls):
    def mk(name, prior):
        def build():
            calls.append(name)
            return None if name.startswith("x") else enh.Candidate(name, IMG, prior)

        return (prior, build)

    return [mk(n, p) for n, p in spec]


SPEC = [("base", 1.0), ("inverted", 0.9), ("retinex", 0.9), ("blackhat", 0.8), ("rl_tv", 0.95)]


def test_under_cap_builds_everything_in_order():
    calls = []
    out = enh._build_within(_plan(SPEC, calls), 6)
    assert [c.name for c in out] == ["base", "inverted", "retinex", "blackhat", "rl_tv"]


def test_over_cap_keeps_highest_priors_in_plan_order():
    calls = []
    out = enh._build_within(_plan(SPEC, calls), 3)
    assert [c.name for c in out] == ["base", "inverted", "rl_tv"]  # 0.95 beats 0.9 retinex and 0.8 blackhat
    assert "blackhat" not in calls and "retinex" not in calls  # dropped variants are never built


def test_unbuildable_variant_gives_its_slot_away():
    calls = []
    spec = [("base", 1.0), ("x_sr", 0.95), ("retinex", 0.9), ("blackhat", 0.8)]
    out = enh._build_within(_plan(spec, calls), 2)
    assert [c.name for c in out] == ["base", "retinex"]


def test_zero_cap_and_empty_plan():
    assert enh._build_within(_plan(SPEC, []), 0) == []
    assert enh._build_within([], 3) == []


def test_matches_budget_rule():
    """Same choice as the existing _budget used for the bloom variants."""
    cands = [enh.Candidate(n, IMG, p) for n, p in SPEC]
    for cap in range(0, 7):
        want = [c.name for c in enh._budget(cands[:1], cands[1:], cap)]
        got = [c.name for c in enh._build_within(_plan(SPEC, []), cap)]
        assert got == want, cap
