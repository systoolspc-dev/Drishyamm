"""Wire format between camera workers and the inference service.

One frame per message, both directions::

    u32 header_len | u32 payload_len | header (JSON, utf-8) | payload (raw bytes)

The header carries the request id, the op and array metadata (shape/dtype);
the payload is the raw NumPy buffer — a 960×544 BGR frame is 1.5 MB and goes
through unencoded. No serialisation library on the hot path, nothing to
install, and the same framing serves shared memory later if the TCP hop
ever measures as the bottleneck (docs/FACE_SYSTEM_DESIGN.md §3.2).
"""
from __future__ import annotations

import asyncio
import json
import socket
import struct
from typing import Any

import numpy as np

_HDR = struct.Struct("!II")
MAX_MESSAGE = 64 * 1024 * 1024   # a frame is ~1.5 MB; 64 MB bounds a corrupt length


def pack(header: dict[str, Any], payload: bytes | memoryview = b"") -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    if not isinstance(payload, (bytes, bytearray)):
        # len() of an N-D memoryview is its first dimension, not its size;
        # flatten so the declared length is the byte count. Needs C-contiguous
        # input, which every caller guarantees with ascontiguousarray.
        payload = memoryview(payload).cast("B")
    return b"".join((_HDR.pack(len(h), len(payload)), h, payload))


def _check(hlen: int, plen: int) -> None:
    if hlen > 1 << 20 or plen > MAX_MESSAGE:
        raise ValueError(f"message too large: header {hlen} payload {plen}")


async def read_message(reader: asyncio.StreamReader) -> tuple[dict[str, Any], bytes]:
    hlen, plen = _HDR.unpack(await reader.readexactly(_HDR.size))
    _check(hlen, plen)
    h = await reader.readexactly(hlen)
    p = await reader.readexactly(plen) if plen else b""
    return json.loads(h.decode("utf-8")), p


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray(n)
    view = memoryview(buf)
    got = 0
    while got < n:
        k = sock.recv_into(view[got:], n - got)
        if k == 0:
            raise ConnectionError("connection closed")
        got += k
    return bytes(buf)


def read_message_sync(sock: socket.socket) -> tuple[dict[str, Any], bytes]:
    hlen, plen = _HDR.unpack(recv_exact(sock, _HDR.size))
    _check(hlen, plen)
    h = recv_exact(sock, hlen)
    p = recv_exact(sock, plen) if plen else b""
    return json.loads(h.decode("utf-8")), p


def array_meta(a: np.ndarray) -> dict[str, Any]:
    return {"shape": list(a.shape), "dtype": str(a.dtype)}


def array_from(meta: dict[str, Any], payload: bytes) -> np.ndarray:
    return np.frombuffer(payload, dtype=np.dtype(meta["dtype"])).reshape(meta["shape"])
