from sqlalchemy import Column, Integer, String, Boolean, DateTime, Enum, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from ..database import Base


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    MANAGER = "manager"
    STAFF = "staff"
    VIEWER = "viewer"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    email = Column(String(150), unique=True, index=True, nullable=False)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), default=UserRole.STAFF, nullable=False)
    phone = Column(String(20))
    avatar_url = Column(String(500))
    is_active = Column(Boolean, default=True)
    # JSON list of page keys; null = role defaults (see permissions.py)
    allowed_pages = Column(Text, nullable=True)
    last_login = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    visits = relationship("Visit", back_populates="created_by_user", foreign_keys="Visit.created_by")
    audit_logs = relationship("AuditLog", back_populates="user")
