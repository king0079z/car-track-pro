from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from ..database import Base


class ServiceCategory(str, enum.Enum):
    WASH = "wash"
    DETAILING = "detailing"
    POLISH = "polish"
    REPAIR = "repair"
    MAINTENANCE = "maintenance"
    INSPECTION = "inspection"
    OTHER = "other"


class Service(Base):
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    category = Column(Enum(ServiceCategory), nullable=False)
    description = Column(Text)
    base_price = Column(Float, default=0.0)
    estimated_duration_minutes = Column(Integer, default=30)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    visit_items = relationship("ServiceItem", back_populates="service")


class ServiceItem(Base):
    __tablename__ = "service_items"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(Integer, ForeignKey("visits.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(Integer, ForeignKey("services.id"), nullable=False)

    # Staff who performed this service
    assigned_staff_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    price = Column(Float, default=0.0)
    notes = Column(Text)
    status = Column(String(20), default="pending")  # pending, in_progress, completed

    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    actual_duration_minutes = Column(Float)  # actual time taken (completed_at - started_at)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    visit = relationship("Visit", back_populates="service_items")
    service = relationship("Service", back_populates="visit_items")
    assigned_staff = relationship("User", foreign_keys=[assigned_staff_id])
