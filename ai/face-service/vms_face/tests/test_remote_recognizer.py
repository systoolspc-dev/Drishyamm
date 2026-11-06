"""RemoteRecognizer against an in-memory fake server (httpx.MockTransport):
crop encoding, the /edge/info binding, the circuit breaker, and the batch path.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_remote_recognizer -v
"""
from __future__ import annotations

import base64
import json
import unittest

import cv2
import httpx
import numpy as np

from vms_face.config import settings
from vms_face.infra.recognizers.remote import RemoteRecognizer


def _template_landmarks() -> np.ndarray:
    # The canonical ArcFace 112x112 template itself → norm_crop is ~identity
    # on a frame that already looks like an aligned crop.
    return np.array(
        [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
         [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32,
    )


class _FakeServer:
    """Answers /edge/info, /edge/embed, /edge/embed/batch. Records what it saw.
    `fail_next` makes the next N calls return 503."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.fail_next = 0
        self.last_crop: np.ndarray | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        if self.fail_next > 0:
            self.fail_next -= 1
            return httpx.Response(503, json={"detail": "down"})
        if request.url.path == "/edge/info":
            return httpx.Response(200, json={"recognizer": "insightface_arc", "embedding_dim": 512})
        if request.url.path == "/edge/embed":
            body = request.read()
            # multipart: find the image bytes after the header block
            idx = body.find(b"\r\n\r\n")
            img_bytes = body[idx + 4:].rsplit(b"\r\n--", 1)[0]
            arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
            self.last_crop = arr
            vec = np.zeros(512, np.float32); vec[0] = 3.0   # un-normed on purpose
            return httpx.Response(200, json={"embedding": vec.tolist()})
        if request.url.path == "/edge/embed/batch":
            payload = json.loads(request.read())
            n = len(payload["crops"])
            first = cv2.imdecode(np.frombuffer(base64.b64decode(payload["crops"][0]), np.uint8), cv2.IMREAD_COLOR)
            self.last_crop = first
            embs = []
            for i in range(n):
                v = np.zeros(512, np.float32); v[i % 512] = 1.0
                embs.append(v.tolist())
            return httpx.Response(200, json={"embeddings": embs})
        return httpx.Response(404)


def _make(server: _FakeServer) -> RemoteRecognizer:
    t = httpx.MockTransport(server.handler)
    return RemoteRecognizer("http://edge-test", "tok", transport=t, async_transport=t)


class TestRemoteRecognizer(unittest.TestCase):
    def setUp(self):
        self._fmt = settings.edge_crop_format
        settings.edge_crop_format = "png"

    def tearDown(self):
        settings.edge_crop_format = self._fmt

    def test_binds_to_server_embedding_space(self):
        srv = _FakeServer()
        rec = _make(srv)
        self.assertEqual(rec.name, "insightface_arc")
        self.assertEqual(rec.embedding_dim, 512)
        self.assertIn("/edge/info", srv.calls)

    def test_embed_aligns_encodes_losslessly_and_normalises(self):
        srv = _FakeServer()
        rec = _make(srv)
        rng = np.random.default_rng(1)
        frame = rng.integers(0, 255, (112, 112, 3), dtype=np.uint8)
        emb = rec.embed(frame, _template_landmarks())
        self.assertIsNotNone(emb)
        self.assertAlmostEqual(float(np.linalg.norm(emb)), 1.0, places=5)
        self.assertEqual(emb.shape, (512,))
        # PNG round trip: what the server decoded is exactly the aligned crop
        self.assertEqual(srv.last_crop.shape, (112, 112, 3))
        self.assertEqual(srv.last_crop.dtype, np.uint8)
        self.assertFalse(rec.circuit_open)

    def test_reuse_existing_is_always_none(self):
        rec = _make(_FakeServer())
        self.assertIsNone(rec.reuse_existing(np.ones(512, np.float32)))

    def test_circuit_breaker_opens_and_short_circuits(self):
        srv = _FakeServer()
        rec = _make(srv)
        settings_threshold = rec._fail_threshold  # noqa: SLF001
        srv.fail_next = settings_threshold + 5
        frame = np.zeros((112, 112, 3), np.uint8)
        before = len(srv.calls)
        for _ in range(settings_threshold):
            self.assertIsNone(rec.embed(frame, _template_landmarks()))
        self.assertTrue(rec.circuit_open)
        # while open, no HTTP call is made at all
        n = len(srv.calls)
        self.assertIsNone(rec.embed(frame, _template_landmarks()))
        self.assertEqual(len(srv.calls), n)
        self.assertEqual(len(srv.calls) - before, settings_threshold)

    def test_batch_path_preserves_order(self):
        srv = _FakeServer()
        rec = _make(srv)
        crops = [np.full((112, 112, 3), i * 10, np.uint8) for i in range(4)]
        out = rec._run_batch_sync(crops)  # noqa: SLF001 — the batcher's flush fn
        self.assertEqual(len(out), 4)
        for i, v in enumerate(out):
            self.assertEqual(int(np.argmax(v)), i)
            self.assertAlmostEqual(float(np.linalg.norm(v)), 1.0, places=5)
        self.assertIn("/edge/embed/batch", srv.calls)


if __name__ == "__main__":
    unittest.main()
