from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from ..database import Base


class VehicleStatus(str, enum.Enum):
    IN_SHOP = "in_shop"
    COMPLETED = "completed"
    WAITING = "waiting"


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(Integer, primary_key=True, index=True)
    plate_number = Column(String(20), unique=True, index=True, nullable=False)
    plate_country = Column(String(10), default="QA")
    make = Column(String(50))
    model = Column(String(50))
    year = Column(Integer)
    color = Column(String(30))
    vehicle_type = Column(String(30), default="sedan")  # sedan, suv, truck, van, motorcycle, other
    vin = Column(String(50), unique=True, index=True)
    owner_name = Column(String(100))
    owner_phone = Column(String(20))
    owner_email = Column(String(150))
    notes = Column(Text)
    image_url = Column(String(500))
    total_visits = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    visits = relationship("Visit", back_populates="vehicle", cascade="all, delete-orphan")
