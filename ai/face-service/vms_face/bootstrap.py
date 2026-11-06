"""One-shot bootstrap for local dev: ensures all infra is alive and seeded.

Run after `docker compose up -d` and `alembic upgrade head`:
    python -m vms_face.bootstrap

Creates a default tenant if none exists and prints its UUID.
"""
from __future__ import annotations

import asyncio

from sqlalchemy import select

from vms_face.core.logging import configure_logging, get_logger
from vms_face.domain.models import Tenant
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import get_qdrant
from vms_face.infra.redis_bus import get_bus

log = get_logger(__name__)


async def main() -> None:
    configure_logging()

    log.info("ensuring qdrant collection")
    qdrant = get_qdrant()
    await qdrant.ensure_collection()

    log.info("ensuring minio buckets")
    get_object_store().ensure_buckets()

    log.info("checking redis")
    bus = get_bus()
    if not await bus.ping():
        raise SystemExit("redis is not reachable")

    log.info("ensuring default tenant")
    async with session_scope() as session:
        existing = await session.execute(select(Tenant).where(Tenant.name == "drisyam-default"))
        tenant = existing.scalar_one_or_none()
        if tenant is None:
            tenant = Tenant(name="drisyam-default")
            session.add(tenant)
            await session.flush()
        log.info("default tenant ready", tenant_id=str(tenant.id))

    await qdrant.close()
    await bus.close()


if __name__ == "__main__":
    asyncio.run(main())
