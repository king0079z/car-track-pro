from sqlalchemy import (
    Column, Integer, String, DateTime, Text, ForeignKey,
    Enum, Float, Boolean, LargeBinary,
)
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from ..database import Base


class VisitStatus(str, enum.Enum):
    WAITING = "waiting"
    IN_SERVICE = "in_service"
    ON_HOLD = "on_hold"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class EntryMethod(str, enum.Enum):
    AUTO_CAMERA = "auto_camera"
    MANUAL = "manual"
    QR_CODE = "qr_code"


class Visit(Base):
    __tablename__ = "visits"

    id = Column(Integer, primary_key=True, index=True)
    visit_number = Column(String(20), unique=True, index=True)

    # Relations
    vehicle_id = Column(Integer, ForeignKey("vehicles.id", ondelete="CASCADE"), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"))
    assigned_bay = Column(Integer)

    # Timing
    entry_time = Column(DateTime(timezone=True), server_default=func.now())
    exit_time = Column(DateTime(timezone=True))
    duration_minutes = Column(Float)
    # Sum of linked ANPR camera-track seconds (VisionFlow) for this visit
    anpr_camera_seconds = Column(Float, nullable=True)

    # Status
    status = Column(Enum(VisitStatus), default=VisitStatus.WAITING, nullable=False)
    entry_method = Column(Enum(EntryMethod), default=EntryMethod.MANUAL)

    # Plate snapshot from camera
    plate_image_url = Column(String(500))
    entry_camera_snapshot = Column(String(500))
    exit_camera_snapshot = Column(String(500))
    plate_confidence = Column(Float)

    # Customer info (override from vehicle if needed)
    customer_name = Column(String(100))
    customer_phone = Column(String(20))
    customer_email = Column(String(150))

    # Signatures (base64 PNG); MySQL TEXT is only 64KB — use LONGTEXT for large canvases
    customer_signature = Column(Text().with_variant(LONGTEXT(), "mysql"))
    supervisor_signature = Column(Text().with_variant(LONGTEXT(), "mysql"))
    supervisor_signed_by = Column(Integer, ForeignKey("users.id"))
    signature_captured_at = Column(DateTime(timezone=True))

    # Financial
    total_price = Column(Float, default=0.0)
    payment_status = Column(String(20), default="unpaid")
    payment_method = Column(String(30))

    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    vehicle = relationship("Vehicle", back_populates="visits")
    created_by_user = relationship("User", back_populates="visits", foreign_keys=[created_by])
    supervisor_user = relationship("User", foreign_keys=[supervisor_signed_by])
    service_items = relationship("ServiceItem", back_populates="visit", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="visit")
    anpr_detections = relationship("ANPRDetection", back_populates="visit")

    @property
    def supervisor_signed_by_user(self):
        return self.supervisor_user
