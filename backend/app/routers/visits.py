from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import UTC, datetime, date, timedelta
from ..database import get_db
from ..models.visit import Visit, VisitStatus
from ..models.vehicle import Vehicle
from ..models.anpr import ANPRDetection
from ..models.service import ServiceItem, Service
from ..schemas.visit import VisitCreate, VisitUpdate, VisitOut, InShopVehicleOut
from ..schemas.service import ServiceItemCreate, ServiceItemUpdate
from ..utils.auth import get_current_user
from ..utils.helpers import generate_visit_number, calculate_duration
from ..models.user import User
from ..services.audit_service import create_audit_log
from ..services.service_duration import sync_visit_shop_duration
from ..services.camera_presence import freeze_visit_camera_recording
from ..utils.qatar_time import qatar_day_start_end, qatar_today

router = APIRouter(prefix="/api/visits", tags=["Visits"])

_MAX_ANPR_LINK = 50
_MAX_ENTRY_ANCHOR_SEC = 6 * 3600


def _apply_anpr_links_on_create(
    db: Session,
    visit: Visit,
    plate_upper: str,
    detection_ids: list[int],
    explicit_entry: Optional[datetime],
) -> None:
    """Attach ANPR rows to this visit; sum VisionFlow track seconds; optionally anchor entry_time."""
    if not detection_ids:
        return
    dets = db.query(ANPRDetection).filter(ANPRDetection.id.in_(detection_ids)).all()
    matched = [d for d in dets if d.plate.upper() == plate_upper]
    if not matched:
        return
    by_id: dict[int, ANPRDetection] = {d.id: d for d in matched}
    for d in matched:
        jid = d.job_id
        if not jid:
            continue
        for r in (
            db.query(ANPRDetection)
            .filter(
                ANPRDetection.job_id == jid,
                ANPRDetection.plate == plate_upper,
                ANPRDetection.visit_id.is_(None),
            )
            .all()
        ):
            by_id.setdefault(r.id, r)
    rows = list(by_id.values())
    total_cam = sum(float(x.duration_sec or 0) for x in rows)
    for x in rows:
        x.visit_id = visit.id
    visit.anpr_camera_seconds = total_cam if total_cam > 0 else None
    if explicit_entry is None:
        anchor = min(total_cam, float(_MAX_ENTRY_ANCHOR_SEC)) if total_cam > 0 else 0.0
        if anchor > 0:
            visit.entry_time = datetime.now(UTC) - timedelta(seconds=anchor)


def _load_visit(db: Session, visit_id: int) -> Visit:
    visit = (
        db.query(Visit)
        .options(
            joinedload(Visit.vehicle),
            joinedload(Visit.created_by_user),
            joinedload(Visit.supervisor_user),
            joinedload(Visit.service_items)
                .joinedload(ServiceItem.service),
            joinedload(Visit.service_items)
                .joinedload(ServiceItem.assigned_staff),
        )
        .filter(Visit.id == visit_id)
        .first()
    )
    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")
    return visit


@router.get("",  response_model=List[VisitOut])
def list_visits(
    status: Optional[VisitStatus] = None,
    date_filter: Optional[date] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    bay: Optional[int] = None,
    plate: Optional[str] = None,
    vehicle_id: Optional[int] = None,
    skip: int = 0,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    q = (
        db.query(Visit)
        .options(
            joinedload(Visit.vehicle),
            joinedload(Visit.created_by_user),
            joinedload(Visit.supervisor_user),
            joinedload(Visit.service_items).joinedload(ServiceItem.service),
            joinedload(Visit.service_items).joinedload(ServiceItem.assigned_staff),
        )
    )
    if status:
        q = q.filter(Visit.status == status)
    if bay:
        q = q.filter(Visit.assigned_bay == bay)
    if date_filter:
        d0, d1 = qatar_day_start_end(date_filter)
        q = q.filter(Visit.entry_time >= d0, Visit.entry_time <= d1)
    if start_date:
        s0, _ = qatar_day_start_end(start_date)
        q = q.filter(Visit.entry_time >= s0)
    if end_date:
        _, e1 = qatar_day_start_end(end_date)
        q = q.filter(Visit.entry_time <= e1)
    if plate:
        q = q.join(Vehicle).filter(Vehicle.plate_number.ilike(f"%{plate}%"))
    if vehicle_id is not None:
        q = q.filter(Visit.vehicle_id == vehicle_id)
    return q.order_by(Visit.entry_time.desc()).offset(skip).limit(limit).all()


@router.post("",  response_model=VisitOut, status_code=201)
def create_visit(data: VisitCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Resolve vehicle
    vehicle = None
    if data.vehicle_id:
        vehicle = db.query(Vehicle).filter(Vehicle.id == data.vehicle_id).first()
    elif data.plate_number:
        vehicle = db.query(Vehicle).filter(Vehicle.plate_number == data.plate_number.upper()).first()
        if not vehicle:
            vehicle = Vehicle(
                plate_number=data.plate_number.upper(),
                vehicle_type=data.vehicle_type or "sedan",
                make=data.make or None,
                model=data.model or None,
                year=data.year or None,
                color=data.color or None,
                owner_name=data.owner_name or data.customer_name or None,
                owner_phone=data.owner_phone or data.customer_phone or None,
                owner_email=data.owner_email or data.customer_email or None,
            )
            db.add(vehicle)
            db.flush()
        else:
            # Backfill blank fields on existing vehicle with anything provided
            if data.vehicle_type:
                vehicle.vehicle_type = data.vehicle_type
            for field in ("make", "model", "year", "color", "owner_name", "owner_phone", "owner_email"):
                incoming = getattr(data, field, None)
                # Also check customer_* aliases for owner_name / owner_phone
                if field == "owner_name" and not incoming:
                    incoming = getattr(data, "customer_name", None)
                if field == "owner_phone" and not incoming:
                    incoming = getattr(data, "customer_phone", None)
                if incoming and not getattr(vehicle, field):
                    setattr(vehicle, field, incoming)

    if not vehicle:
        raise HTTPException(status_code=400, detail="Vehicle not found. Provide vehicle_id or plate_number.")

    raw_anpr = list(dict.fromkeys(data.anpr_detection_ids or []))
    if len(raw_anpr) > _MAX_ANPR_LINK:
        raise HTTPException(status_code=400, detail=f"Too many ANPR detection ids (max {_MAX_ANPR_LINK})")

    sig = data.supervisor_signature or data.customer_signature
    visit = Visit(
        visit_number=generate_visit_number(),
        vehicle_id=vehicle.id,
        created_by=current_user.id,
        assigned_bay=data.assigned_bay,
        entry_method=data.entry_method,
        customer_name=data.customer_name or vehicle.owner_name,
        customer_phone=data.customer_phone or vehicle.owner_phone,
        customer_email=data.customer_email or vehicle.owner_email,
        supervisor_signature=sig or None,
        supervisor_signed_by=current_user.id if sig else None,
        signature_captured_at=datetime.now(UTC) if sig else None,
        notes=data.notes,
        status=VisitStatus.WAITING,
        entry_time=data.entry_time if data.entry_time is not None else datetime.now(UTC),
    )
    db.add(visit)
    db.flush()

    _apply_anpr_links_on_create(db, visit, vehicle.plate_number.upper(), raw_anpr, data.entry_time)
    db.flush()

    for si in (data.service_ids or []):
        svc = db.query(Service).filter(Service.id == si.service_id).first()
        if svc:
            item = ServiceItem(
                visit_id=visit.id,
                service_id=si.service_id,
                price=si.price if si.price is not None else svc.base_price,
                notes=si.notes,
                assigned_staff_id=si.assigned_staff_id,
            )
            db.add(item)

    vehicle.total_visits = (vehicle.total_visits or 0) + 1
    # Compute total price from service items
    db.flush()
    total = sum(si.price or 0 for si in visit.service_items)
    visit.total_price = round(total, 2)
    plate = vehicle.plate_number if vehicle else None
    create_audit_log(
        db,
        user_id=current_user.id,
        action="create",
        entity_type="visit",
        entity_id=visit.id,
        visit_id=visit.id,
        description=f"Opened work order {visit.visit_number}" + (f" · {plate}" if plate else ""),
        commit=False,
    )
    if visit.signature_captured_at or visit.exit_time:
        freeze_visit_camera_recording(db, visit)
        sync_visit_shop_duration(db, visit)
    db.commit()
    return _load_visit(db, visit.id)


@router.get("/in-shop", response_model=List[InShopVehicleOut])
def list_in_shop_vehicles(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Vehicles currently on the shop floor — open work orders plus camera-detected plates
    awaiting registration (no exit / not completed).
    """
    active = (
        db.query(Visit)
        .options(
            joinedload(Visit.vehicle),
            joinedload(Visit.service_items).joinedload(ServiceItem.service),
        )
        .filter(Visit.status.in_([VisitStatus.WAITING, VisitStatus.IN_SERVICE, VisitStatus.ON_HOLD]))
        .order_by(Visit.entry_time.asc())
        .all()
    )

    plates_with_wo: set[str] = set()
    out: list[InShopVehicleOut] = []

    for v in active:
        if not v.vehicle:
            continue
        plate = v.vehicle.plate_number.upper()
        plates_with_wo.add(plate)
        svc_names = ", ".join(
            si.service.name for si in (v.service_items or []) if si.service and si.service.name
        )[:120]
        mins = calculate_duration(v.entry_time, None) if v.entry_time else 0.0
        out.append(
            InShopVehicleOut(
                plate_number=plate,
                source="active_visit",
                visit_id=v.id,
                work_order_number=v.visit_number,
                status=v.status,
                assigned_bay=v.assigned_bay,
                entry_time=v.entry_time,
                vehicle_id=v.vehicle_id,
                make=v.vehicle.make,
                model=v.vehicle.model,
                color=v.vehicle.color,
                customer_name=v.customer_name or v.vehicle.owner_name,
                minutes_in_shop=round(mins, 1),
                service_summary=svc_names or None,
            )
        )

    today_start, today_end = qatar_day_start_end(qatar_today())
    anpr_rows = (
        db.query(ANPRDetection)
        .filter(
            ANPRDetection.detected_at >= today_start,
            ANPRDetection.detected_at <= today_end,
            ANPRDetection.visit_id.is_(None),
        )
        .order_by(ANPRDetection.detected_at.desc())
        .all()
    )
    anpr_by_plate: dict[str, list[ANPRDetection]] = {}
    for row in anpr_rows:
        p = row.plate.upper()
        if p in plates_with_wo:
            continue
        anpr_by_plate.setdefault(p, []).append(row)

    for plate, dets in anpr_by_plate.items():
        vehicle = db.query(Vehicle).filter(Vehicle.plate_number == plate).first()
        out.append(
            InShopVehicleOut(
                plate_number=plate,
                source="anpr_pending",
                vehicle_id=vehicle.id if vehicle else None,
                make=vehicle.make if vehicle else None,
                model=vehicle.model if vehicle else None,
                color=vehicle.color if vehicle else None,
                customer_name=vehicle.owner_name if vehicle else None,
                anpr_detection_ids=[d.id for d in dets[:24]],
            )
        )

    return out


@router.get("/active", response_model=List[VisitOut])
def get_active_visits(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visits = (
        db.query(Visit)
        .options(joinedload(Visit.vehicle), joinedload(Visit.service_items).joinedload(ServiceItem.service))
        .filter(Visit.status.in_([VisitStatus.WAITING, VisitStatus.IN_SERVICE, VisitStatus.ON_HOLD]))
        .order_by(Visit.entry_time.asc())
        .all()
    )
    return visits


@router.get("/{visit_id}", response_model=VisitOut)
def get_visit(visit_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _load_visit(db, visit_id)


@router.patch("/{visit_id}", response_model=VisitOut)
def update_visit(
    visit_id: int,
    data: VisitUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    visit = _load_visit(db, visit_id)
    update_data = data.model_dump(exclude_unset=True)

    if "status" in update_data and update_data["status"] == VisitStatus.COMPLETED:
        if not visit.exit_time and "exit_time" not in update_data:
            visit.exit_time = datetime.now(UTC)

    for k, v in update_data.items():
        setattr(visit, k, v)

    if update_data.get("supervisor_signature"):
        if not visit.signature_captured_at:
            visit.signature_captured_at = datetime.now(UTC)
            visit.supervisor_signed_by = current_user.id
        freeze_visit_camera_recording(db, visit)
        sync_visit_shop_duration(db, visit)
    elif visit.status == VisitStatus.COMPLETED and visit.entry_time and visit.exit_time:
        visit.duration_minutes = calculate_duration(visit.entry_time, visit.exit_time)

    db.commit()
    return _load_visit(db, visit.id)


@router.post("/{visit_id}/checkout", response_model=VisitOut)
def checkout_visit(visit_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visit = _load_visit(db, visit_id)
    visit.exit_time = datetime.now(UTC)
    visit.status = VisitStatus.COMPLETED
    visit.duration_minutes = calculate_duration(visit.entry_time, visit.exit_time)
    freeze_visit_camera_recording(db, visit)
    sync_visit_shop_duration(db, visit)
    create_audit_log(
        db,
        user_id=current_user.id,
        action="checkout",
        entity_type="visit",
        entity_id=visit.id,
        visit_id=visit.id,
        description=f"Checked out {visit.visit_number} · QAR {visit.total_price or 0}",
        new_values={"duration_minutes": visit.duration_minutes, "total_price": visit.total_price},
        commit=False,
    )
    db.commit()
    return _load_visit(db, visit.id)


@router.post("/{visit_id}/signature", response_model=VisitOut)
def capture_signature(
    visit_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    visit = _load_visit(db, visit_id)
    sig = payload.get("supervisor_signature") or payload.get("signature")
    visit.supervisor_signature = sig
    visit.supervisor_signed_by = current_user.id if sig else None
    visit.signature_captured_at = datetime.now(UTC) if sig else None
    if sig:
        freeze_visit_camera_recording(db, visit)
        sync_visit_shop_duration(db, visit)
    db.commit()
    return _load_visit(db, visit.id)


def _recalc_visit_total(db: Session, visit: Visit) -> None:
    db.flush()
    visit.total_price = round(sum((si.price or 0) for si in visit.service_items), 2)


@router.post("/{visit_id}/services", response_model=VisitOut, status_code=201)
def add_service_item(
    visit_id: int,
    data: ServiceItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    visit = _load_visit(db, visit_id)
    if visit.status == VisitStatus.COMPLETED:
        raise HTTPException(status_code=400, detail="Cannot add services to a completed visit")
    svc = db.query(Service).filter(Service.id == data.service_id).first()
    if not svc:
        raise HTTPException(status_code=404, detail="Service not found")
    item = ServiceItem(
        visit_id=visit_id,
        service_id=data.service_id,
        price=data.price if data.price is not None else svc.base_price,
        notes=data.notes,
        assigned_staff_id=data.assigned_staff_id,
    )
    db.add(item)
    _recalc_visit_total(db, visit)
    db.commit()
    return _load_visit(db, visit_id)


@router.patch("/{visit_id}/services/{item_id}", response_model=VisitOut)
def update_service_item(
    visit_id: int, item_id: int, data: ServiceItemUpdate,
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    visit = _load_visit(db, visit_id)
    item = db.query(ServiceItem).filter(ServiceItem.id == item_id, ServiceItem.visit_id == visit_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Service item not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    if item.started_at and item.completed_at:
        item.actual_duration_minutes = calculate_duration(item.started_at, item.completed_at)
    _recalc_visit_total(db, visit)
    db.commit()
    return _load_visit(db, visit_id)


@router.delete("/{visit_id}", status_code=204)
def delete_visit(visit_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visit = db.query(Visit).filter(Visit.id == visit_id).first()
    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")
    num = visit.visit_number
    create_audit_log(
        db,
        user_id=current_user.id,
        action="delete",
        entity_type="visit",
        entity_id=visit_id,
        description=f"Deleted visit {num}",
        commit=False,
    )
    db.delete(visit)
    db.commit()
