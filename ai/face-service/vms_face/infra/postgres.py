from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from vms_face.config import settings

_engine = create_async_engine(
    settings.postgres_dsn,
    echo=False,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)
_session_factory = async_sessionmaker(_engine, expire_on_commit=False)


def get_engine():
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return _session_factory


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    async with _session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def fastapi_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency. Caller controls commits via service layer."""
    async with _session_factory() as session:
        yield session
