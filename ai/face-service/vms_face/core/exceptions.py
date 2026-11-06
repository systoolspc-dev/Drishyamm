from __future__ import annotations


class VMSError(Exception):
    """Base error for the VMS face service."""


class ConfigurationError(VMSError):
    pass


class InferenceError(VMSError):
    pass


class StorageError(VMSError):
    pass


class NotFoundError(VMSError):
    pass


class DuplicateError(VMSError):
    pass


class StreamError(VMSError):
    pass
