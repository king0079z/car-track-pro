from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from ..database import get_db
from ..models.vehicle import Vehicle
from ..models.visit import Visit
from ..models.service import ServiceItem
from ..schemas.vehicle import VehicleCreate, VehicleUpdate, VehicleOut
from ..schemas.visit import VisitOut
from ..utils.auth import get_current_user, require_manager, require_page, require_any_page
from ..models.user import User
from ..services.audit_service import create_audit_log
from ..services.permissions import apply_visit_scope
from ..services.vehicle_identity import find_duplicate_groups, find_vehicle_for_plate, merge_vehicles

router = APIRouter(prefix="/api/vehicles", tags=["Vehicles"])


@router.get("",  response_model=List[VehicleOut])
def list_vehicles(
    search: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_page("vehicles"))
):
    q = db.query(Vehicle)
    if search:
        q = q.filter(
            Vehicle.plate_number.ilike(f"%{search}%") |
            Vehicle.owner_name.ilike(f"%{search}%") |
            Vehicle.make.ilike(f"%{search}%") |
            Vehicle.model.ilike(f"%{search}%")
        )
    return q.order_by(Vehicle.created_at.desc()).offset(skip).limit(limit).all()


@router.post("",  response_model=VehicleOut, status_code=201)
def create_vehicle(data: VehicleCreate, db: Session = Depends(get_db), current_user: User = Depends(require_any_page("vehicles", "visits"))):
    plate = (data.plate_number or "").strip().upper()
    existing = find_vehicle_for_plate(db, plate, fuzzy=True)
    if existing:
        # Reuse the canonical row instead of spawning an OCR duplicate.
        return existing
    vehicle = Vehicle(**data.model_dump())
    vehicle.plate_number = plate
    db.add(vehicle)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.get("/lookup/{plate_number}")
def lookup_plate(plate_number: str, db: Session = Depends(get_db), current_user: User = Depends(require_any_page("vehicles", "visits"))):
    vehicle = find_vehicle_for_plate(db, plate_number, fuzzy=True)
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    # Return vehicle with visit count and last visit date
    last_visit = (
        db.query(Visit)
        .filter(Visit.vehicle_id == vehicle.id)
        .order_by(Visit.entry_time.desc())
        .first()
    )
    return {
        **VehicleOut.model_validate(vehicle).model_dump(),
        "last_visit": last_visit.entry_time.isoformat() if last_visit else None,
    }


@router.get("/duplicates")
def list_duplicate_vehicles(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Likely-duplicate vehicle groups (OCR misreads) for the merge tool."""
    return {"groups": find_duplicate_groups(db)}


@router.get("/{vehicle_id}", response_model=VehicleOut)
def get_vehicle(vehicle_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_page("vehicles"))):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return vehicle


@router.get("/{vehicle_id}/history")
def get_vehicle_history(
    vehicle_id: int,
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("vehicles", "visits"))
):
    """Full visit history for a vehicle with services and staff."""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    visits = (
        apply_visit_scope(
            db.query(Visit)
            .options(
                joinedload(Visit.created_by_user),
                joinedload(Visit.service_items).joinedload(ServiceItem.service),
                joinedload(Visit.service_items).joinedload(ServiceItem.assigned_staff),
            )
            .filter(Visit.vehicle_id == vehicle_id),
            current_user,
        )
        .order_by(Visit.entry_time.desc())
        .limit(limit)
        .all()
    )

    visit_list = []
    total_spent = 0.0
    total_duration = 0.0
    duration_count = 0

    for v in visits:
        services = []
        for si in v.service_items:
            services.append({
                "id": si.id,
                "service_name": si.service.name if si.service else "Unknown",
                "service_category": si.service.category.value if si.service else "other",
                "price": si.price,
                "status": si.status,
                "staff_name": si.assigned_staff.full_name if si.assigned_staff else None,
                "started_at": si.started_at.isoformat() if si.started_at else None,
                "completed_at": si.completed_at.isoformat() if si.completed_at else None,
                "actual_duration_minutes": si.actual_duration_minutes,
                "notes": si.notes,
            })

        total_spent += v.total_price or 0
        if v.duration_minutes:
            total_duration += v.duration_minutes
            duration_count += 1

        visit_list.append({
            "id": v.id,
            "visit_number": v.visit_number,
            "entry_time": v.entry_time.isoformat(),
            "exit_time": v.exit_time.isoformat() if v.exit_time else None,
            "duration_minutes": v.duration_minutes,
            "status": v.status.value,
            "assigned_bay": v.assigned_bay,
            "customer_name": v.customer_name,
            "total_price": v.total_price,
            "payment_status": v.payment_status,
            "entry_method": v.entry_method.value,
            "created_by": v.created_by_user.full_name if v.created_by_user else None,
            "notes": v.notes,
            "services": services,
        })

    return {
        "vehicle": VehicleOut.model_validate(vehicle).model_dump(),
        "visits": visit_list,
        "summary": {
            "total_visits": len(visits),
            "total_spent": round(total_spent, 2),
            "avg_duration_minutes": round(total_duration / duration_count, 1) if duration_count else 0,
            "services_used": list({s["service_name"] for v in visit_list for s in v["services"]}),
        }
    }


@router.patch("/{vehicle_id}", response_model=VehicleOut)
def update_vehicle(vehicle_id: int, data: VehicleUpdate, db: Session = Depends(get_db), current_user: User = Depends(require_any_page("vehicles", "visits"))):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(vehicle, k, v)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.patch("/{vehicle_id}/plate")
def correct_plate(
    vehicle_id: int,
    plate_number: str = Body(..., embed=True),
    merge_if_exists: bool = Body(False, embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("vehicles", "visits")),
):
    """Fix an OCR-misread plate. If the corrected plate already belongs to
    another vehicle, returns 409 with that vehicle (or merges this vehicle
    into it when ``merge_if_exists`` is true)."""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    new_plate = (plate_number or "").strip().upper()
    if len(new_plate) < 2:
        raise HTTPException(status_code=400, detail="Plate number is too short")
    old_plate = vehicle.plate_number

    existing = find_vehicle_for_plate(db, new_plate, fuzzy=True)
    if existing and existing.id != vehicle.id:
        if not merge_if_exists:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"Plate {new_plate} already belongs to vehicle #{existing.id}.",
                    "existing_vehicle_id": existing.id,
                    "hint": "Retry with merge_if_exists=true to merge this vehicle into it.",
                },
            )
        stats = merge_vehicles(db, target=existing, source=vehicle)
        create_audit_log(
            db,
            user_id=current_user.id,
            action="merge",
            entity_type="vehicle",
            entity_id=existing.id,
            description=f"Plate correction {old_plate} → {new_plate}: merged duplicate vehicle",
            old_values={"plate_number": old_plate},
            new_values={"plate_number": new_plate, **stats},
            commit=False,
        )
        db.commit()
        return {"ok": True, "merged_into": existing.id, **stats}

    vehicle.plate_number = new_plate
    create_audit_log(
        db,
        user_id=current_user.id,
        action="correct_plate",
        entity_type="vehicle",
        entity_id=vehicle.id,
        description=f"Corrected plate {old_plate} → {new_plate}",
        old_values={"plate_number": old_plate},
        new_values={"plate_number": new_plate},
        commit=False,
    )
    db.commit()
    db.refresh(vehicle)
    return {"ok": True, "vehicle": VehicleOut.model_validate(vehicle).model_dump()}


@router.post("/{vehicle_id}/merge")
def merge_vehicle(
    vehicle_id: int,
    source_vehicle_id: int = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Merge ``source_vehicle_id`` (the OCR duplicate) into ``vehicle_id``
    (the correct record): visits + detections move, duplicate is deleted."""
    target = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    source = db.query(Vehicle).filter(Vehicle.id == source_vehicle_id).first()
    if not target or not source:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    if target.id == source.id:
        raise HTTPException(status_code=400, detail="Cannot merge a vehicle into itself")
    stats = merge_vehicles(db, target=target, source=source)
    create_audit_log(
        db,
        user_id=current_user.id,
        action="merge",
        entity_type="vehicle",
        entity_id=target.id,
        description=(
            f"Merged duplicate {stats['merged_plate']} into {target.plate_number} "
            f"({stats['visits_moved']} visits, {stats['detections_moved']} detections)"
        ),
        new_values=stats,
        commit=False,
    )
    db.commit()
    return {"ok": True, "target_id": target.id, **stats}


@router.delete("/{vehicle_id}", status_code=204)
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_manager)):
    """Deleting a vehicle removes ALL its visits (cascade) — manager/admin only."""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    create_audit_log(
        db,
        user_id=current_user.id,
        action="delete",
        entity_type="vehicle",
        entity_id=vehicle.id,
        description=f"Deleted vehicle {vehicle.plate_number} and its visit history",
        old_values={"plate_number": vehicle.plate_number, "total_visits": vehicle.total_visits},
        commit=False,
    )
    db.delete(vehicle)
    db.commit()
