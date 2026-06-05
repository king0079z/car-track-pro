from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from ..models.visit import VisitStatus, EntryMethod
from .vehicle import VehicleOut
from .service import ServiceItemOut, ServiceItemCreate


class CreatedByUser(BaseModel):
    id: int
    full_name: str
    username: str

    class Config:
        from_attributes = True


class VisitCreate(BaseModel):
    vehicle_id: Optional[int] = None
    plate_number: Optional[str] = None
    # Vehicle detail fields — saved to the Vehicle record on create / backfill
    vehicle_type: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    year: Optional[int] = None
    color: Optional[str] = None
    owner_name: Optional[str] = None
    owner_phone: Optional[str] = None
    owner_email: Optional[str] = None
    # Visit fields
    assigned_bay: Optional[int] = None
    entry_method: EntryMethod = EntryMethod.MANUAL
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_signature: Optional[str] = None
    supervisor_signature: Optional[str] = None
    notes: Optional[str] = None
    service_ids: Optional[List[ServiceItemCreate]] = []
    # Optional explicit entry instant (otherwise server default = now)
    entry_time: Optional[datetime] = None
    # Link VisionFlow ANPR rows (same plate) — sums camera-track seconds & anchors entry when possible
    anpr_detection_ids: Optional[List[int]] = None


class VisitUpdate(BaseModel):
    status: Optional[VisitStatus] = None
    assigned_bay: Optional[int] = None
    exit_time: Optional[datetime] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_signature: Optional[str] = None
    supervisor_signature: Optional[str] = None
    notes: Optional[str] = None
    payment_status: Optional[str] = None
    payment_method: Optional[str] = None
    total_price: Optional[float] = None


class VisitOut(BaseModel):
    id: int
    visit_number: str
    vehicle_id: int
    vehicle: VehicleOut
    created_by_user: Optional[CreatedByUser] = None
    assigned_bay: Optional[int] = None
    entry_time: datetime
    exit_time: Optional[datetime] = None
    duration_minutes: Optional[float] = None
    anpr_camera_seconds: Optional[float] = None
    status: VisitStatus
    entry_method: EntryMethod
    plate_image_url: Optional[str] = None
    entry_camera_snapshot: Optional[str] = None
    plate_confidence: Optional[float] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_signature: Optional[str] = None
    supervisor_signature: Optional[str] = None
    supervisor_signed_by_user: Optional[CreatedByUser] = None
    signature_captured_at: Optional[datetime] = None
    total_price: float
    payment_status: str
    payment_method: Optional[str] = None
    notes: Optional[str] = None
    service_items: List[ServiceItemOut] = []
    created_at: datetime
    class Config:
        from_attributes = True


class InShopVehicleOut(BaseModel):
    """Vehicle on the shop floor — open work order or camera-detected, awaiting registration."""
    plate_number: str
    source: str  # active_visit | anpr_pending
    visit_id: Optional[int] = None
    work_order_number: Optional[str] = None
    status: Optional[VisitStatus] = None
    assigned_bay: Optional[int] = None
    entry_time: Optional[datetime] = None
    vehicle_id: Optional[int] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    customer_name: Optional[str] = None
    minutes_in_shop: Optional[float] = None
    service_summary: Optional[str] = None
    anpr_detection_ids: Optional[List[int]] = None

    class Config:
        from_attributes = True
