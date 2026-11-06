from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import db_session, require_admin
from vms_face.core.security import Principal
from vms_face.domain.models import Tenant

# Tenant CRUD crosses tenant boundaries by definition. Every route here is
# admin-gated; an "operator" role token gets 403, even on read.
router = APIRouter(prefix="/tenants", tags=["tenants"])


class TenantCreate(BaseModel):
    name: str


class TenantOut(BaseModel):
    id: uuid.UUID
    name: str

    class Config:
        from_attributes = True


@router.post("", response_model=TenantOut, status_code=status.HTTP_201_CREATED)
async def create_tenant(
    payload: TenantCreate,
    session: AsyncSession = Depends(db_session),
    _admin: Principal = Depends(require_admin),
) -> TenantOut:
    tenant = Tenant(name=payload.name)
    session.add(tenant)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(409, "tenant name already exists") from e
    await session.refresh(tenant)
    return TenantOut.model_validate(tenant)


@router.get("", response_model=list[TenantOut])
async def list_tenants(
    session: AsyncSession = Depends(db_session),
    _admin: Principal = Depends(require_admin),
) -> list[TenantOut]:
    rows = (await session.execute(select(Tenant).order_by(Tenant.created_at))).scalars().all()
    return [TenantOut.model_validate(t) for t in rows]
