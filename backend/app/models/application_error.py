from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from ..database import Base


class ApplicationError(Base):
    """Structured application errors — VisionFlow, ANPR, API, client, and system."""

    __tablename__ = "application_errors"

    id = Column(Integer, primary_key=True, index=True)
    severity = Column(String(20), nullable=False, index=True)  # debug|info|warning|error|critical
    category = Column(String(40), nullable=False, index=True)  # visionflow|anpr|camera|api|client|database|system
    source = Column(String(120), nullable=False)
    message = Column(Text, nullable=False)
    detail = Column(Text)
    stack_trace = Column(Text)
    context = Column(JSON)
    fingerprint = Column(String(128), index=True)
    occurrence_count = Column(Integer, default=1, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    job_id = Column(String(64), index=True)
    plate = Column(String(32))
    track_id = Column(Integer)
    ip_address = Column(String(45))
    resolved = Column(Boolean, default=False, nullable=False, index=True)
    resolved_at = Column(DateTime(timezone=True))
    resolved_by = Column(Integer, ForeignKey("users.id"))
    last_seen_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    user = relationship("User", foreign_keys=[user_id])
    resolver = relationship("User", foreign_keys=[resolved_by])
