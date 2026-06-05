from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from ..models.service import ServiceCategory


class ServiceBase(BaseModel):
    name: str
    category: ServiceCategory
    description: Optional[str] = None
    base_price: float = 0.0
    estimated_duration_minutes: Optional[int] = None
    is_active: bool = True


class ServiceCreate(ServiceBase):
    pass


class ServiceUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[ServiceCategory] = None
    description: Optional[str] = None
    base_price: Optional[float] = None
    estimated_duration_minutes: Optional[int] = None
    is_active: Optional[bool] = None


class ServiceOut(ServiceBase):
    id: int
    created_at: datetime
    estimated_duration_minutes: int = 30
    duration_job_count: int = 0
    duration_source: str = "default"
    is_auto_calculated: bool = False

    class Config:
        from_attributes = True


class StaffMini(BaseModel):
    id: int
    full_name: str
    username: str

    class Config:
        from_attributes = True


class ServiceItemCreate(BaseModel):
    service_id: int
    price: Optional[float] = None
    notes: Optional[str] = None
    assigned_staff_id: Optional[int] = None


class ServiceItemOut(BaseModel):
    id: int
    visit_id: int
    service_id: int
    service: ServiceOut
    assigned_staff_id: Optional[int] = None
    assigned_staff: Optional[StaffMini] = None
    price: float
    notes: Optional[str] = None
    status: str
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    actual_duration_minutes: Optional[float] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ServiceItemUpdate(BaseModel):
    status: Optional[str] = None
    assigned_staff_id: Optional[int] = None
    notes: Optional[str] = None
    price: Optional[float] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
