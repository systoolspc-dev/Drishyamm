"""JWT verification (core/security.py) and credential encryption (core/crypto.py).

These are the two primitives everything else trusts: the tenant of every
request comes from `decode_token`, and every camera password at rest goes
through `encrypt`/`decrypt`. The rules below are the ones an attacker would
probe: expired / forged / re-signed / alg=none tokens, tokens with no tenant,
the dev bypass leaking into stage/prod, and tampered ciphertext.

The container env sets real secrets, so every test pins the settings it
depends on and restores them afterwards. No network, no DB.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_security -v
"""
from __future__ import annotations

import base64
import contextlib
import dataclasses
import json
import os
import time
import unittest
import uuid
import warnings

import jwt

from vms_face.config import settings
from vms_face.core import crypto, security
from vms_face.core.security import (
    AuthError,
    Principal,
    decode_token,
    dev_bypass_allowed,
    issue_token,
    jwt_configured,
)

SECRET = "s" * 40
OTHER_SECRET = "o" * 40
TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
ISS = "drisyam-vms-test"
AUD = "drisyam-vms-test-aud"


@contextlib.contextmanager
def override(**kw):
    old = {k: getattr(settings, k) for k in kw}
    for k, v in kw.items():
        setattr(settings, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(settings, k, v)


def jwt_settings(**extra):
    base = dict(
        vms_jwt_secret=SECRET,
        vms_jwt_algorithm="HS256",
        vms_jwt_issuer=ISS,
        vms_jwt_audience=AUD,
        vms_jwt_leeway_sec=30,
    )
    base.update(extra)
    return override(**base)


def claims(**over):
    now = int(time.time())
    c = {
        "iss": ISS,
        "aud": AUD,
        "sub": "op-1",
        "tid": str(TENANT),
        "role": "operator",
        "scopes": ["events:read"],
        "iat": now,
        "exp": now + 600,
    }
    for k, v in over.items():
        if v is _DROP:
            c.pop(k, None)
        else:
            c[k] = v
    return c


_DROP = object()


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


class SecretConfigTest(unittest.TestCase):
    def test_short_secret_counts_as_unconfigured(self):
        with jwt_settings(vms_jwt_secret="x" * 31):
            self.assertFalse(jwt_configured())

    def test_32_char_secret_is_configured(self):
        with jwt_settings(vms_jwt_secret="x" * 32):
            self.assertTrue(jwt_configured())

    def test_whitespace_padding_does_not_count_towards_length(self):
        with jwt_settings(vms_jwt_secret="   " + "x" * 31 + "    "):
            self.assertFalse(jwt_configured())

    def test_empty_secret_refuses_to_issue(self):
        with jwt_settings(vms_jwt_secret=""):
            with self.assertRaises(AuthError):
                issue_token(subject="a", tenant_id=TENANT)

    def test_unconfigured_secret_refuses_to_verify_anything(self):
        with jwt_settings():
            tok = issue_token(subject="a", tenant_id=TENANT)
        with jwt_settings(vms_jwt_secret="short"):
            with self.assertRaises(AuthError):
                decode_token(tok)


class IssueAndDecodeTest(unittest.TestCase):
    def test_roundtrip_carries_tenant_subject_role_and_scopes(self):
        with jwt_settings():
            tok = issue_token(subject="op-7", tenant_id=TENANT, role="admin", scopes=("a:r", "b:w"))
            p = decode_token(tok)
        self.assertEqual(p.tenant_id, TENANT)
        self.assertIsInstance(p.tenant_id, uuid.UUID)
        self.assertEqual(p.subject, "op-7")
        self.assertEqual(p.role, "admin")
        self.assertEqual(p.scopes, ("a:r", "b:w"))
        self.assertTrue(p.is_admin)
        self.assertTrue(p.has_scope("b:w"))
        self.assertFalse(p.has_scope("c:x"))

    def test_extra_claims_cannot_overwrite_the_tenant_or_subject(self):
        other = uuid.uuid4()
        with jwt_settings():
            tok = issue_token(subject="op", tenant_id=TENANT,
                              extra_claims={"tid": str(other), "sub": "root", "role": "admin", "x": 1})
            p = decode_token(tok)
        self.assertEqual(p.tenant_id, TENANT)
        self.assertEqual(p.subject, "op")
        self.assertEqual(p.role, "operator")
        self.assertEqual(p.raw["x"], 1)

    def test_ttl_has_a_60_second_floor(self):
        with jwt_settings():
            tok = issue_token(subject="op", tenant_id=TENANT, ttl_sec=0)
            c = decode_token(tok).raw
        self.assertGreaterEqual(c["exp"] - c["iat"], 60)

    def test_subject_is_truncated_to_128_chars(self):
        with jwt_settings():
            tok = jwt.encode(claims(sub="a" * 500), SECRET, algorithm="HS256")
            self.assertEqual(len(decode_token(tok).subject), 128)

    def test_missing_role_defaults_to_operator_not_admin(self):
        with jwt_settings():
            tok = jwt.encode(claims(role=_DROP), SECRET, algorithm="HS256")
            p = decode_token(tok)
        self.assertEqual(p.role, "operator")
        self.assertFalse(p.is_admin)

    def test_admin_role_check_is_case_insensitive(self):
        self.assertTrue(Principal(subject="s", tenant_id=TENANT, role="ADMIN").is_admin)
        self.assertFalse(Principal(subject="s", tenant_id=TENANT, role="administrator").is_admin)

    def test_principal_is_immutable(self):
        p = Principal(subject="s", tenant_id=TENANT)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.tenant_id = uuid.uuid4()  # type: ignore[misc]


class RejectionTest(unittest.TestCase):
    """Every way a token can be wrong must raise AuthError (never a partial
    Principal, never a different exception type that a route might not catch)."""

    def assertRejected(self, token: str):
        with self.assertRaises(AuthError):
            decode_token(token)

    def test_expired_token_is_rejected(self):
        now = int(time.time())
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(iat=now - 3600, exp=now - 120), SECRET, algorithm="HS256"))

    def test_expiry_inside_the_leeway_is_still_accepted(self):
        now = int(time.time())
        with jwt_settings(vms_jwt_leeway_sec=30):
            p = decode_token(jwt.encode(claims(iat=now - 600, exp=now - 5), SECRET, algorithm="HS256"))
        self.assertEqual(p.tenant_id, TENANT)

    def test_token_signed_with_another_secret_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(), OTHER_SECRET, algorithm="HS256"))

    def test_rotating_the_secret_invalidates_old_tokens(self):
        with jwt_settings():
            tok = issue_token(subject="op", tenant_id=TENANT)
        with jwt_settings(vms_jwt_secret=OTHER_SECRET):
            self.assertRejected(tok)

    def test_alg_none_is_rejected(self):
        tok = f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(claims())}."
        with jwt_settings():
            self.assertRejected(tok)

    def test_alg_none_from_pyjwt_is_rejected(self):
        tok = jwt.encode(claims(), None, algorithm="none")
        with jwt_settings():
            self.assertRejected(tok)

    def test_other_hmac_algorithm_with_same_secret_is_rejected(self):
        with jwt_settings(), warnings.catch_warnings():
            warnings.simplefilter("ignore")      # PyJWT: 40-byte key is short for SHA512
            self.assertRejected(jwt.encode(claims(), SECRET, algorithm="HS512"))

    def test_header_alg_swapped_after_signing_is_rejected(self):
        with jwt_settings():
            tok = jwt.encode(claims(), SECRET, algorithm="HS256")
            _, payload, sig = tok.split(".")
            forged = f"{_b64({'alg': 'HS512', 'typ': 'JWT'})}.{payload}.{sig}"
            self.assertRejected(forged)

    def test_payload_tampered_to_another_tenant_is_rejected(self):
        with jwt_settings():
            tok = jwt.encode(claims(), SECRET, algorithm="HS256")
            head, _, sig = tok.split(".")
            forged = f"{head}.{_b64(claims(tid=str(uuid.uuid4())))}.{sig}"
            self.assertRejected(forged)

    def test_missing_tid_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(tid=_DROP), SECRET, algorithm="HS256"))

    def test_null_tid_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(tid=None), SECRET, algorithm="HS256"))

    def test_non_uuid_tid_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(tid="tenant-1"), SECRET, algorithm="HS256"))
            self.assertRejected(jwt.encode(claims(tid=12345), SECRET, algorithm="HS256"))

    def test_each_required_claim_is_enforced(self):
        with jwt_settings():
            for missing in ("exp", "iat", "iss", "aud", "sub", "tid"):
                with self.subTest(missing=missing):
                    self.assertRejected(jwt.encode(claims(**{missing: _DROP}), SECRET, algorithm="HS256"))

    def test_wrong_issuer_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(iss="someone-else"), SECRET, algorithm="HS256"))

    def test_wrong_audience_is_rejected(self):
        with jwt_settings():
            self.assertRejected(jwt.encode(claims(aud="another-service"), SECRET, algorithm="HS256"))

    def test_garbage_is_rejected(self):
        with jwt_settings():
            for junk in ("", "abc", "a.b.c", "Bearer x.y.z"):
                with self.subTest(junk=junk):
                    self.assertRejected(junk)


class DevBypassTest(unittest.TestCase):
    def test_bypass_needs_dev_env_and_the_flag(self):
        cases = {
            ("dev", True): True,
            ("dev", False): False,
            ("stage", True): False,
            ("stage", False): False,
            ("prod", True): False,
            ("prod", False): False,
        }
        for (env, flag), want in cases.items():
            with self.subTest(env=env, flag=flag), override(vms_env=env, vms_jwt_dev_bypass=flag):
                self.assertIs(dev_bypass_allowed(), want)

    def test_bypass_flag_default_is_off(self):
        from vms_face.config.settings import Settings

        self.assertIs(Settings.model_fields["vms_jwt_dev_bypass"].default, False)

    def test_bypass_does_not_make_jwt_count_as_configured(self):
        with override(vms_env="dev", vms_jwt_dev_bypass=True, vms_jwt_secret=""):
            self.assertTrue(dev_bypass_allowed())
            self.assertFalse(security.jwt_configured())


# ── crypto ────────────────────────────────────────────────────────────────

KEY = base64.b64encode(bytes(range(32))).decode()
KEY2 = base64.b64encode(bytes(range(1, 33))).decode()


@contextlib.contextmanager
def cred_key(value: str):
    with override(vms_camera_cred_key=value):
        crypto._aesgcm.cache_clear()
        try:
            yield
        finally:
            crypto._aesgcm.cache_clear()
    crypto._aesgcm.cache_clear()


class CryptoTest(unittest.TestCase):
    URL = "rtsp://admin:s3cret@10.0.0.5:554/stream1"

    def test_roundtrip_with_a_key(self):
        with cred_key(KEY):
            self.assertTrue(crypto.encryption_enabled())
            enc = crypto.encrypt(self.URL)
            self.assertTrue(enc.startswith(crypto.PREFIX))
            self.assertNotIn("s3cret", enc)
            self.assertEqual(crypto.decrypt(enc), self.URL)

    def test_unicode_roundtrip(self):
        with cred_key(KEY):
            s = "rtsp://उपयोगकर्ता:pässwörd@host/ch"
            self.assertEqual(crypto.decrypt(crypto.encrypt(s)), s)

    def test_each_encryption_uses_a_fresh_nonce(self):
        with cred_key(KEY):
            a, b = crypto.encrypt(self.URL), crypto.encrypt(self.URL)
        self.assertNotEqual(a, b)

    def test_without_a_key_encrypt_is_a_passthrough(self):
        with cred_key(""):
            self.assertFalse(crypto.encryption_enabled())
            self.assertEqual(crypto.encrypt(self.URL), self.URL)

    def test_legacy_plaintext_rows_read_back_unchanged_with_a_key(self):
        with cred_key(KEY):
            self.assertEqual(crypto.decrypt(self.URL), self.URL)

    def test_none_passes_through(self):
        with cred_key(KEY):
            self.assertIsNone(crypto.encrypt(None))  # type: ignore[arg-type]
            self.assertIsNone(crypto.decrypt(None))  # type: ignore[arg-type]

    def test_encrypted_row_without_key_fails_instead_of_returning_ciphertext(self):
        with cred_key(KEY):
            enc = crypto.encrypt(self.URL)
        with cred_key(""):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.decrypt(enc)

    def test_wrong_key_fails_loudly(self):
        with cred_key(KEY):
            enc = crypto.encrypt(self.URL)
        with cred_key(KEY2):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.decrypt(enc)

    def test_tampered_ciphertext_is_detected(self):
        with cred_key(KEY):
            enc = crypto.encrypt(self.URL)
            raw = bytearray(base64.b64decode(enc[len(crypto.PREFIX):]))
            raw[crypto.NONCE_LEN + 2] ^= 0x01
            forged = crypto.PREFIX + base64.b64encode(bytes(raw)).decode()
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.decrypt(forged)

    def test_malformed_base64_blob_raises(self):
        with cred_key(KEY):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.decrypt(crypto.PREFIX + "!!!not base64!!!")

    def test_blob_shorter_than_nonce_raises(self):
        with cred_key(KEY):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.decrypt(crypto.PREFIX + base64.b64encode(b"\x00" * crypto.NONCE_LEN).decode())

    def test_key_of_wrong_length_fails_closed(self):
        with cred_key(base64.b64encode(os.urandom(16)).decode()):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.encryption_enabled()

    def test_non_base64_key_fails_closed(self):
        with cred_key("this is not base64 at all!"):
            with self.assertRaises(crypto.CryptoConfigError):
                crypto.encrypt("x")


if __name__ == "__main__":
    unittest.main()
