"""SQLAlchemy custom column types.

`EncryptedString` transparently encrypts on bind (write) and decrypts on
result-processing (read), using `core.crypto.encrypt`/`decrypt`. The DB-side
column is plain Text — no schema change needed to enable encryption.

When the encryption key is unset, both directions are pass-throughs so the
type is safe to deploy ahead of key provisioning.
"""
from __future__ import annotations

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from vms_face.core.crypto import decrypt as _decrypt
from vms_face.core.crypto import encrypt as _encrypt


class EncryptedString(TypeDecorator):
    """TEXT column that round-trips through AES-256-GCM at the application
    layer. Cache-ok=True because the decorator is stateless — the key is
    resolved each call from the cached settings singleton."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return _encrypt(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return _decrypt(value)
