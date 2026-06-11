from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from ..database import get_db
from ..models.service import Service, ServiceItem
from ..schemas.service import ServiceCreate, ServiceUpdate, ServiceOut
from ..utils.auth import get_current_user, require_manager, require_any_page
from ..models.user import User
from ..services.service_duration import (
    category_default_duration,
    recompute_and_update_service_duration,
    service_duration_insight,
    DEFAULT_DURATION,
)

router = APIRouter(prefix="/api/services", tags=["Services"])


def _service_out(db: Session, service: Service) -> ServiceOut:
    insight = service_duration_insight(db, service)
    est = insight["estimated_duration_minutes"] or service.estimated_duration_minutes or DEFAULT_DURATION
    return ServiceOut(
        id=service.id,
        name=service.name,
        category=service.category,
        description=service.description,
        base_price=service.base_price,
        estimated_duration_minutes=est,
        is_active=service.is_active,
        created_at=service.created_at,
        duration_job_count=insight["duration_job_count"],
        duration_source=insight["duration_source"],
        is_auto_calculated=insight["is_auto_calculated"],
    )


@router.get("", response_model=List[ServiceOut])
def list_services(db: Session = Depends(get_db), current_user: User = Depends(require_any_page("services", "visits"))):
    rows = db.query(Service).filter(Service.is_active == True).order_by(Service.category, Service.name).all()
    return [_service_out(db, s) for s in rows]


@router.post("", response_model=ServiceOut, status_code=201)
def create_service(data: ServiceCreate, db: Session = Depends(get_db), current_user: User = Depends(require_manager)):
    payload = data.model_dump(exclude={"estimated_duration_minutes"})
    service = Service(**payload)
    if data.estimated_duration_minutes is not None:
        service.estimated_duration_minutes = data.estimated_duration_minutes
    else:
        service.estimated_duration_minutes = category_default_duration(db, service.category)
    db.add(service)
    db.commit()
    db.refresh(service)
    recompute_and_update_service_duration(db, service.id)
    db.commit()
    db.refresh(service)
    return _service_out(db, service)


@router.get("/{service_id}", response_model=ServiceOut)
def get_service(service_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_any_page("services", "visits"))):
    service = db.query(Service).filter(Service.id == service_id).first()
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    return _service_out(db, service)


@router.patch("/{service_id}", response_model=ServiceOut)
def update_service(service_id: int, data: ServiceUpdate, db: Session = Depends(get_db), current_user: User = Depends(require_manager)):
    service = db.query(Service).filter(Service.id == service_id).first()
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "estimated_duration_minutes":
            continue
        setattr(service, k, v)
    db.commit()
    recompute_and_update_service_duration(db, service.id)
    db.commit()
    db.refresh(service)
    return _service_out(db, service)


@router.delete("/{service_id}", status_code=204)
def delete_service(service_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_manager)):
    service = db.query(Service).filter(Service.id == service_id).first()
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    service.is_active = False
    db.commit()
