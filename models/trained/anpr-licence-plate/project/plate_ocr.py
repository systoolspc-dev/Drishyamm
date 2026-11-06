"""
plate_ocr.py — fast-plate-ocr wrapper that returns per-character confidences.

One session shared by every camera thread, guarded by a lock (the ONNX session
is not guaranteed thread-safe). `read_many` batches all enhancement variants of
one crop into ONE inference call — that's what makes multi-hypothesis OCR
affordable: 6 variants cost about 1.5× one read, not 6×.

Colour handling: fast-plate-ocr assumes in-memory arrays are ALREADY in the
model's colour mode (grayscale for the CCT models). We look at the loaded
config and convert here, once, instead of relying on the library's fallback.
"""

from __future__ import annotations

import math
import os
import re
import sys
import threading

import cv2
import numpy as np

from plate_rules import (
    CODE_PRIOR_WEIGHT,
    ONE_DIGIT_DISTRICT_PENALTY,
    STATE_CODES,
    TEMPLATE_PRIOR,
    TEMPLATES,
    TO_DIGIT,
    TO_LETTER,
    TWO_DIGIT_DISTRICT_STATES,
    code_of,
    is_valid_plate,
    validate_or_correct,
)

# A look-alike glyph is EVIDENCE for its counterpart in a slot of the other
# class: the OCR saying "Z" at 0.96 in a digit slot is mostly a 2 (same
# strokes, different training prior). Share that probability at this rate.
LOOKALIKE_SHARE = float(os.getenv("ANPR_LOOKALIKE_SHARE", "0.7"))
from plate_votes import Read

# Accept the constrained decode only if its joint log-prob is within this many
# nats of the unconstrained greedy read — beyond that the read is probably not
# an Indian plate at all (foreign, damaged, or not a plate) and forcing it
# would manufacture a plausible-looking wrong answer.
_CONSTRAIN_MAX_PENALTY = 6.0


def constrained_decode(P: np.ndarray, alphabet: str, pad: str, code_prior: dict | None = None):
    """Format-constrained MAP decode over the OCR's per-slot distributions.

        ĉ_i = argmax_c  p_OCR(c | x) · p_format(c | position i, template)

    P: (slots, |alphabet|) probabilities. Tries every Indian template whose
    length is plausible given where the pad character starts, forces letter
    slots to letters and digit slots to digits, applies the state-code prior
    on the first two slots, and returns the best (text, probs, template,
    logp, greedy_text, greedy_logp). This is the Bayesian version of the
    substitution table in plate_rules — it can pick the SECOND-best glyph
    when the best one is impossible in that slot ('O' in a digit slot → '0'
    only if '0' is what the OCR actually saw second)."""
    slots, A = P.shape
    idx = {c: i for i, c in enumerate(alphabet)}
    pad_i = idx.get(pad, None)
    letters = np.array([i for i, c in enumerate(alphabet) if c.isalpha()])
    digits = np.array([i for i, c in enumerate(alphabet) if c.isdigit()])
    eps = 1e-6
    # confusion-aware copies of P: in a DIGIT slot a look-alike letter lends
    # its probability to the digit (Z→2, O→0, S→5, B→8 …) and vice versa in a
    # LETTER slot — the same position rules plate_rules applies, but inside
    # the MAP decode where they can compete with the raw glyph evidence.
    P_d = P.copy()
    for L_, D_ in TO_DIGIT.items():
        if L_ in idx and D_ in idx:
            P_d[:, idx[D_]] = np.maximum(P_d[:, idx[D_]], P[:, idx[L_]] * LOOKALIKE_SHARE)
    P_l = P.copy()
    for D_, L_ in TO_LETTER.items():
        if L_ in idx and D_ in idx:
            P_l[:, idx[L_]] = np.maximum(P_l[:, idx[L_]], P[:, idx[D_]] * LOOKALIKE_SHARE)
    logP = np.log(P + eps)
    logP_d = np.log(P_d + eps)
    logP_l = np.log(P_l + eps)

    # greedy (unconstrained) read + its length
    am = P.argmax(1)
    greedy = "".join(alphabet[i] for i in am)
    if pad_i is not None:
        greedy_len = len(greedy.split(pad)[0]) if pad in greedy else slots
        greedy = greedy[:greedy_len]
    else:
        greedy_len = slots
    greedy_logp = float(sum(logP[i, am[i]] for i in range(min(greedy_len, slots))))

    def len_score(L):
        if pad_i is None:
            return 0.0
        s = 0.0
        for i in range(slots):
            s += math.log(1 - P[i, pad_i] + eps) if i < L else logP[i, pad_i]
        return s

    best = None
    for L in range(max(8, greedy_len - 1), min(11, greedy_len + 1, slots) + 1):
        for tpl in TEMPLATES.get(L, []):
            lp = len_score(L)
            chars, probs = [], []
            ok = True
            for i, t in enumerate(tpl):
                if t == "L":
                    allowed, Pq, logPq = letters, P_l, logP_l
                elif t == "D":
                    allowed, Pq, logPq = digits, P_d, logP_d
                else:  # fixed literal (B / H of the Bharat series)
                    j = idx.get(t)
                    if j is None:
                        ok = False
                        break
                    chars.append(t)
                    probs.append(float(P_l[i, j]))
                    lp += float(logP_l[i, j])
                    continue
                j = int(allowed[Pq[i, allowed].argmax()])
                chars.append(alphabet[j])
                probs.append(float(Pq[i, j]))
                lp += float(logPq[i, j])
            if not ok:
                continue
            text = "".join(chars)
            lp += TEMPLATE_PRIOR.get(tpl, -1.0)  # p_format over plate SHAPES
            if tpl.startswith("LL") and text[:2] not in STATE_CODES:
                # state-code prior: best valid pair among the top-3 letters per slot
                top0 = letters[np.argsort(-P[0, letters])[:3]]
                top1 = letters[np.argsort(-P[1, letters])[:3]]
                cand = None
                for a in top0:
                    for b in top1:
                        code = alphabet[a] + alphabet[b]
                        if code in STATE_CODES:
                            s = float(logP[0, a] + logP[1, b])
                            if cand is None or s > cand[0]:
                                cand = (s, code, float(P[0, a]), float(P[1, b]))
                if cand is not None:
                    lp += cand[0] - float(logP[0, idx[text[0]]] + logP[1, idx[text[1]]])
                    text = cand[1] + text[2:]
                    probs[0], probs[1] = cand[2], cand[3]
                else:
                    lp -= 4.0
            # 1-digit district in a state whose RTO codes are always 2 digits
            if tpl.startswith("LLDL") and text[:2] in TWO_DIGIT_DISTRICT_STATES:
                lp += ONE_DIGIT_DISTRICT_PENALTY
            # per-camera prior: which registration codes THIS camera sees
            if code_prior and tpl.startswith("LL"):
                c = code_of(text)
                if c:
                    lp += CODE_PRIOR_WEIGHT * code_prior.get(c, code_prior.get("__other__", 0.0))
            if best is None or lp > best[3]:
                best = (text, probs, tpl, lp)
    # compare like with like: the constrained score includes the length
    # (pad-position) terms, so the greedy score must too
    greedy_logp += len_score(min(greedy_len, slots))
    if best is None:
        # No Indian template of this length (a two-row HALF, a partial or a
        # foreign plate): hand back the greedy read so the caller still gets
        # text — read_two_line concatenates halves, the rules judge the whole.
        gprobs = [float(P[i, am[i]]) for i in range(min(greedy_len, slots))]
        return (greedy, gprobs, None, greedy_logp, greedy, greedy_logp)
    return (*best, greedy, greedy_logp)


# v2 global models FIRST: they have 10 output slots. The v1 CCT models and the
# mobile-vit model have 9 — they physically cannot emit a 10-character Indian
# plate (GJ01AB1234 came back as 9 chars), which silently truncated every
# standard plate read before 2026-08-28. Order = accuracy (s > xs), then fallbacks.
_OCR_CANDIDATES = (
    "cct-s-v2-global-model",
    "cct-xs-v2-global-model",
    "cct-xs-v1-global-model",
    "global-plates-mobile-vit-v2-model",
)


def clean_text(text) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(text or "").upper())


class PlateOcr:
    def __init__(self, names=_OCR_CANDIDATES, device: str | None = None):
        from fast_plate_ocr import LicensePlateRecognizer

        last = None
        self._ocr = None
        # Bounded ONNX threads: one shared session serves every camera thread
        # behind a lock, so a machine-sized intra-op pool only adds contention.
        sess_opts = None
        try:
            import onnxruntime as ort

            sess_opts = ort.SessionOptions()
            sess_opts.intra_op_num_threads = int(os.getenv("ANPR_OCR_THREADS", "4"))
            sess_opts.inter_op_num_threads = 1
        except Exception:  # noqa: BLE001
            sess_opts = None
        # A FINE-TUNED model (train_ocr.py output) wins over the hub models:
        # ANPR_OCR_MODEL_DIR containing model.onnx + plate_config.yaml.
        custom_dir = os.getenv(
            "ANPR_OCR_MODEL_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ocr")
        )
        custom = (os.path.join(custom_dir, "model.onnx"), os.path.join(custom_dir, "plate_config.yaml"))
        if all(os.path.exists(p) for p in custom):
            try:
                kw = {"onnx_model_path": custom[0], "plate_config_path": custom[1]}
                if sess_opts is not None:
                    kw["sess_options"] = sess_opts
                self._ocr = LicensePlateRecognizer(**kw)
                self.name = f"custom:{os.path.basename(custom_dir)}"
            except Exception as e:  # noqa: BLE001 — fall back to the hub
                last = e
                self._ocr = None
        for name in names if self._ocr is None else ():
            for kw in (
                {"device": device, "sess_options": sess_opts},
                {"device": device},
                {"sess_options": sess_opts},
                {},
            ):
                kw = {k: v for k, v in kw.items() if v is not None}
                try:
                    self._ocr = LicensePlateRecognizer(name, **kw)
                    self.name = name
                    break
                except TypeError:
                    continue  # this signature doesn't take that kwarg
                except Exception as e:  # noqa: BLE001 — try next candidate model
                    last = e
                    break
            if self._ocr is not None:
                break
        if self._ocr is None:
            raise RuntimeError(f"no plate-OCR model loadable: {last}")
        cfg = getattr(self._ocr, "config", None)
        mode = str(getattr(cfg, "image_color_mode", "grayscale") or "grayscale").lower()
        self.gray = mode.startswith("gray")
        self._lock = threading.Lock()
        # Direct access to the ONNX head for the constrained decoder: we need the
        # WHOLE per-slot distribution, run() only returns the argmax and its prob.
        self.alphabet = str(getattr(cfg, "alphabet", "") or "")
        self.pad = str(getattr(cfg, "pad_char", "_") or "_")
        self.slots = int(getattr(cfg, "max_plate_slots", 0) or 0)
        self._sess = getattr(self._ocr, "model", None)
        self._out_name = getattr(self._ocr, "plate_output_name", None)
        mod = sys.modules.get(type(self._ocr).__module__)
        self._load = getattr(mod, "_load_image_from_source", None)
        self._prep_fn = getattr(mod, "preprocess_image", None)
        self.constrained = bool(
            self.alphabet
            and self.slots
            and self._sess is not None
            and self._out_name
            and self._load
            and self._prep_fn
        )

    def _distributions(self, batch: list[np.ndarray]) -> np.ndarray | None:
        """→ (N, slots, |alphabet|) probabilities, or None if the head can't be read.

        Only the ONNX run holds the reader lock. Resizing and stacking the batch
        (and decoding the output) are per-call CPU work with no shared state,
        so cameras sharing this reader do them in parallel instead of queueing."""
        if not self.constrained:
            return None
        try:
            x = self._prep_fn(self._load(batch, self._ocr.config))
            with self._lock:
                out = self._sess.run([self._out_name], {"input": x})[0]
            A = len(self.alphabet)
            if out.size != len(batch) * self.slots * A:
                return None
            P = out.reshape(len(batch), self.slots, A).astype(np.float32)
            # some exports emit logits; softmax if rows don't sum to ~1
            if not np.allclose(P[0].sum(1), 1.0, atol=0.05):
                P = np.exp(P - P.max(2, keepdims=True))
                P /= P.sum(2, keepdims=True)
            return P
        except Exception:  # noqa: BLE001
            return None

    def _prep(self, img: np.ndarray) -> np.ndarray:
        if img is None or img.size == 0:
            return None
        if self.gray:
            return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if img.ndim == 2:
            return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    def read_many(
        self,
        images: list[np.ndarray],
        variants: list[str] | None = None,
        priors: list[float] | None = None,
        det_conf: float = 1.0,
        code_prior: dict | None = None,
    ) -> list[Read]:
        """OCR a batch; returns one Read per image that produced text."""
        prepped = [self._prep(im) for im in images]
        keep = [i for i, p in enumerate(prepped) if p is not None]
        if not keep:
            return []
        batch = [prepped[i] for i in keep]
        try:
            P = self._distributions(batch)  # takes the lock for the model run only
            preds = None
            if P is None:
                with self._lock:
                    preds = self._ocr.run(batch, return_confidence=True)
        except Exception:  # noqa: BLE001 — one bad batch must not kill the loop
            return []
        out: list[Read] = []
        for j in range(len(batch)):
            i = keep[j]
            text, plist, corrected = None, None, None
            if P is not None:
                dec = constrained_decode(P[j], self.alphabet, self.pad, code_prior)
                if dec is None:
                    continue
                ctext, cprobs, tpl, clogp, greedy, glogp = dec
                text = clean_text(greedy)[:12]
                if len(text) < 2 and len(ctext) < 2:
                    continue
                if tpl is None:
                    ctext = ""  # no template matched → greedy only
                # greedy probs for the raw read
                gam = P[j].argmax(1)
                plist = [float(P[j][k, gam[k]]) for k in range(min(len(text), self.slots))]
                # A read that fills EVERY slot of a model with < 11 slots may be
                # a longer plate cut short (3-letter series on a 10-slot model,
                # anything on a 9-slot one). Don't let the rules "validate" a
                # truncated string into a plausible wrong plate.
                truncated = len(text) >= self.slots and self.slots < 11 and self.slots != 10
                if (
                    not truncated
                    and ctext
                    and is_valid_plate(ctext)
                    and clogp >= glogp - _CONSTRAIN_MAX_PENALTY
                ):
                    corrected = ctext
                    if ctext != text:
                        plist = cprobs  # vote with the constrained glyph probs
                elif not truncated:
                    corrected = validate_or_correct(text)
                else:
                    corrected = None
            else:
                pred = preds[j]
                raw = getattr(pred, "plate", None)
                if raw is None:
                    raw = str(pred) if pred is not None else ""
                text = clean_text(raw)[:12]
                if len(text) < 4:
                    continue
                probs = getattr(pred, "char_probs", None)
                if probs is not None:
                    arr = np.asarray(probs, dtype=np.float32).ravel()
                    if arr.size >= len(text):
                        plist = [float(x) for x in arr[: len(text)]]
                    elif arr.size > 0:
                        plist = [float(x) for x in arr] + [float(arr.mean())] * (len(text) - arr.size)
                corrected = validate_or_correct(text)
            conf = float(np.mean(plist)) if plist else 0.5
            prior = priors[i] if priors and i < len(priors) else 1.0
            variant = variants[i] if variants and i < len(variants) else f"v{i}"
            if len(text or "") < 4 and not corrected and not variant.startswith("row"):
                continue  # noise; halves of a two-row plate are allowed to be short
            out.append(
                Read(
                    text=text or corrected,
                    probs=plist,
                    weight=float(prior * conf * max(0.2, det_conf)),
                    variant=variant,
                    valid=corrected is not None,
                    corrected=corrected,
                )
            )
        return out

    def read_two_line(
        self, top: np.ndarray, bottom: np.ndarray, det_conf: float = 1.0, prior: float = 0.95
    ) -> Read | None:
        """Two-row plate (bikes, trucks): OCR each row, concatenate, then run
        the rules on the joined string. The row split itself comes from
        plate_enhance.split_two_line."""
        parts = self.read_many([top, bottom], ["row1", "row2"], [1.0, 1.0], det_conf)
        if len(parts) != 2 or {parts[0].variant, parts[1].variant} != {"row1", "row2"}:
            return None
        a, b = sorted(parts, key=lambda r: r.variant)
        text = clean_text(a.text + b.text)[:12]
        probs = (a.probs or []) + (b.probs or [])
        corrected = validate_or_correct(text)
        conf = float(np.mean(probs)) if probs else 0.5
        return Read(
            text=text,
            probs=probs or None,
            weight=float(prior * conf * max(0.2, det_conf)),
            variant="two_line",
            valid=corrected is not None,
            corrected=corrected,
        )

    def read(self, image: np.ndarray) -> Read | None:
        reads = self.read_many([image])
        return reads[0] if reads else None


class PlateOcrEnsemble:
    """Two (or more) DIFFERENT recognisers read every crop; the voter fuses
    them per character. Diversity is the point: the s and xs CCT models (and
    a fine-tuned model when present) make different mistakes, so a glyph both
    agree on is far more likely right than either alone — the "second reader"
    that a comparison-based decision needs. Reader 0 is the primary (its
    colour mode / slots drive the two-row path); the others add reads tagged
    `variant@rN` with a slightly lower prior."""

    def __init__(self, readers: list[PlateOcr], weights: list[float] | None = None):
        self.readers = readers
        self.weights = weights or [1.0] + [0.9] * (len(readers) - 1)
        self.name = " + ".join(r.name for r in readers)
        self.gray = readers[0].gray
        self.slots = readers[0].slots
        self.constrained = readers[0].constrained

    @classmethod
    def from_env(cls) -> "PlateOcrEnsemble":
        spec = [
            s.strip()
            for s in os.getenv("ANPR_OCR_READERS", "primary,cct-xs-v2-global-model").split(",")
            if s.strip()
        ]
        readers: list[PlateOcr] = []
        for s in spec:
            try:
                r = PlateOcr() if s == "primary" else PlateOcr(names=(s,))
                if any(x.name == r.name for x in readers):
                    continue  # the primary already IS this hub model
                readers.append(r)
            except Exception as e:  # noqa: BLE001 — a missing second reader must not stop the worker
                print(f"[plate_ocr] reader {s!r} unavailable: {e}", flush=True)
        if not readers:
            readers = [PlateOcr()]
        return cls(readers)

    def read_many(
        self, images, variants=None, priors=None, det_conf: float = 1.0, code_prior=None
    ) -> list[Read]:
        out: list[Read] = []
        for i, r in enumerate(self.readers):
            w = self.weights[i] if i < len(self.weights) else 0.9
            reads = r.read_many(images, variants, priors, det_conf, code_prior)
            for rd in reads:
                if i > 0:
                    rd.variant = f"{rd.variant}@r{i}"
                    rd.weight *= w
                out.append(rd)
        return out

    def read_two_line(self, top, bottom, det_conf: float = 1.0, prior: float = 0.95) -> Read | None:
        return self.readers[0].read_two_line(top, bottom, det_conf, prior)
