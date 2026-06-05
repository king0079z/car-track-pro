from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from ..database import get_db
from ..models.vehicle import Vehicle
from ..models.visit import Visit
from ..models.service import ServiceItem
from ..schemas.vehicle import VehicleCreate, VehicleUpdate, VehicleOut
from ..schemas.visit import VisitOut
from ..utils.auth import get_current_user
from ..models.user import User

router = APIRouter(prefix="/api/vehicles", tags=["Vehicles"])


@router.get("",  response_model=List[VehicleOut])
def list_vehicles(
    search: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
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
def create_vehicle(data: VehicleCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    existing = db.query(Vehicle).filter(Vehicle.plate_number == data.plate_number.upper()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Vehicle with this plate number already exists")
    vehicle = Vehicle(**data.model_dump())
    vehicle.plate_number = vehicle.plate_number.upper()
    db.add(vehicle)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.get("/lookup/{plate_number}")
def lookup_plate(plate_number: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.plate_number == plate_number.upper()).first()
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


@router.get("/{vehicle_id}", response_model=VehicleOut)
def get_vehicle(vehicle_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return vehicle


@router.get("/{vehicle_id}/history")
def get_vehicle_history(
    vehicle_id: int,
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Full visit history for a vehicle with services and staff."""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    visits = (
        db.query(Visit)
        .options(
            joinedload(Visit.created_by_user),
            joinedload(Visit.service_items).joinedload(ServiceItem.service),
            joinedload(Visit.service_items).joinedload(ServiceItem.assigned_staff),
        )
        .filter(Visit.vehicle_id == vehicle_id)
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
def update_vehicle(vehicle_id: int, data: VehicleUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(vehicle, k, v)
    db.commit()
    db.refresh(vehicle)
    return vehicle


@router.delete("/{vehicle_id}", status_code=204)
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    db.delete(vehicle)
    db.commit()
