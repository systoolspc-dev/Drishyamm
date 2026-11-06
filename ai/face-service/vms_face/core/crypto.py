"""AES-256-GCM envelope around camera credentials at rest.

Used by the SQLAlchemy `EncryptedString` TypeDecorator on `Camera.rtsp_url`.

Format on disk:

    <prefix><base64( nonce || ciphertext || tag )>

The prefix `enc:v1:` lets us distinguish encrypted from plaintext rows during
the migration window: legacy rows lacking the prefix are read as-is. New writes
always go through encrypt(); when `vms_camera_cred_key` is unset, encrypt is a
no-op pass-through (legacy mode).

Key handling:
  - `vms_camera_cred_key` is base64-encoded raw bytes; decoded length must
    be exactly 32 bytes (AES-256). Anything else fails closed at startup.
  - Single key, no rotation. To rotate later, dump-decrypt-encrypt-load with
    the new key in place; we do not support multi-key reads in v1.

Why GCM over CBC: GCM has built-in authentication (the tag). A swap on disk
that flips ciphertext bytes is detected on decrypt instead of returning
garbage. Required for tamper-evident credential storage.
"""
from __future__ import annotations

import base64
import os
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from vms_face.config import settings

PREFIX = "enc:v1:"
NONCE_LEN = 12   # GCM standard


class CryptoConfigError(RuntimeError):
    """Raised when vms_camera_cred_key is set but malformed."""


@lru_cache(maxsize=1)
def _aesgcm() -> AESGCM | None:
    """Build the AESGCM cipher from settings, cached. Returns None when no
    key is configured (legacy plaintext mode)."""
    raw = (settings.vms_camera_cred_key or "").strip()
    if not raw:
        return None
    try:
        key = base64.b64decode(raw, validate=True)
    except (ValueError, base64.binascii.Error) as e:
        raise CryptoConfigError(
            "VMS_CAMERA_CRED_KEY must be base64-encoded 32 raw bytes"
        ) from e
    if len(key) != 32:
        raise CryptoConfigError(
            f"VMS_CAMERA_CRED_KEY must decode to exactly 32 bytes (got {len(key)})"
        )
    return AESGCM(key)


def encryption_enabled() -> bool:
    """True iff a usable key is configured. Cheap; cached."""
    return _aesgcm() is not None


def encrypt(plaintext: str) -> str:
    """Wrap a string for at-rest storage. When encryption is disabled this is
    a pass-through; when enabled the output starts with the PREFIX so a future
    decrypt() can route correctly."""
    if plaintext is None:
        return plaintext  # type: ignore[return-value]
    aes = _aesgcm()
    if aes is None:
        return plaintext
    nonce = os.urandom(NONCE_LEN)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), associated_data=None)
    blob = base64.b64encode(nonce + ct).decode("ascii")
    return f"{PREFIX}{blob}"


def decrypt(value: str) -> str:
    """Inverse of encrypt(). Plaintext rows (no PREFIX) pass through unchanged
    so the migration window works. A row with the PREFIX but bad tag raises —
    don't silently return scrambled data."""
    if value is None or not value.startswith(PREFIX):
        return value
    aes = _aesgcm()
    if aes is None:
        # We have an encrypted row but no key — refuse to fabricate plaintext.
        raise CryptoConfigError(
            "Encrypted row encountered but VMS_CAMERA_CRED_KEY is unset"
        )
    blob = value[len(PREFIX):]
    try:
        raw = base64.b64decode(blob, validate=True)
    except (ValueError, base64.binascii.Error) as e:
        raise CryptoConfigError(f"malformed encrypted blob: {e}") from e
    if len(raw) <= NONCE_LEN:
        raise CryptoConfigError("encrypted blob shorter than nonce")
    nonce, ct = raw[:NONCE_LEN], raw[NONCE_LEN:]
    try:
        pt = aes.decrypt(nonce, ct, associated_data=None)
    except InvalidTag as e:
        # Authentication failure — bytes were tampered or key rotated. Loud.
        raise CryptoConfigError("AES-GCM tag mismatch on decrypt") from e
    return pt.decode("utf-8")
