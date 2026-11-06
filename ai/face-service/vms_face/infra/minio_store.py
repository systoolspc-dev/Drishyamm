from __future__ import annotations

import io
from datetime import timedelta

from minio import Minio
from minio.error import S3Error

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)


class ObjectStore:
    """MinIO/S3 wrapper for snapshots and enrollment images."""

    def __init__(self) -> None:
        self._client = Minio(
            settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )

    def ensure_buckets(self) -> None:
        # Includes the journey-output bucket so the stitch worker (which never
        # runs the API lifespan) can rely on it after a one-time startup call.
        for bucket in (
            settings.minio_bucket_snapshots,
            settings.minio_bucket_enrollments,
            settings.minio_bucket_output,
        ):
            self.ensure_bucket(bucket)

    def ensure_bucket(self, bucket: str) -> None:
        """Idempotently create one bucket. Safe to call from the stitch worker."""
        try:
            if not self._client.bucket_exists(bucket):
                self._client.make_bucket(bucket)
                log.info("created bucket", bucket=bucket)
        except S3Error as e:
            log.error("bucket setup failed", bucket=bucket, err=str(e))
            raise

    def put_bytes(self, bucket: str, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        try:
            self._client.put_object(
                bucket_name=bucket, object_name=key,
                data=io.BytesIO(data), length=len(data), content_type=content_type,
            )
        except S3Error as e:
            # Worker path may write before any lifespan ran — create on demand.
            if getattr(e, "code", "") in ("NoSuchBucket", "NoSuchBucketPolicy"):
                self.ensure_bucket(bucket)
                self._client.put_object(
                    bucket_name=bucket, object_name=key,
                    data=io.BytesIO(data), length=len(data), content_type=content_type,
                )
            else:
                raise
        return f"s3://{bucket}/{key}"

    def get_bytes(self, bucket: str, key: str) -> bytes:
        """Fetch an object's bytes. Sync — call via run_in_executor from async code."""
        resp = self._client.get_object(bucket, key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    def object_exists(self, bucket: str, key: str) -> bool:
        try:
            self._client.stat_object(bucket, key)
            return True
        except S3Error:
            return False

    @staticmethod
    def parse_s3_uri(uri: str) -> tuple[str | None, str | None]:
        """s3://bucket/key → (bucket, key); (None, None) when not an s3 uri."""
        if not uri or not uri.startswith("s3://"):
            return None, None
        bucket, _, key = uri[len("s3://"):].partition("/")
        return (bucket or None), (key or None)

    def get_presigned_url(self, bucket: str, key: str, expires_minutes: int = 30) -> str:
        return self._client.presigned_get_object(
            bucket_name=bucket,
            object_name=key,
            expires=timedelta(minutes=expires_minutes),
        )


_store: ObjectStore | None = None


def get_object_store() -> ObjectStore:
    global _store
    if _store is None:
        _store = ObjectStore()
    return _store
