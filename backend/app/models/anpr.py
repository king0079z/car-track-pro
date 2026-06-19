"""
ANPRDetection — stores every licence plate that VisionFlow reads from a video.
Each row auto-links to a Vehicle row (if one exists with that plate) and
can optionally reference the Visit that was created from this detection.
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class ANPRDetection(Base):
    __tablename__ = "anpr_detections"

    id            = Column(Integer, primary_key=True, index=True)
    plate         = Column(String(30), nullable=False, index=True)
    speed_kmh     = Column(Float, nullable=True)
    track_id      = Column(Integer, nullable=True)

    # Source reference
    job_id        = Column(String(64), nullable=True, index=True)   # VisionFlow job_id
    video_name    = Column(String(255), nullable=True)

    # Link to CarTrack entities (optional – populated by sync)
    vehicle_id    = Column(Integer, ForeignKey("vehicles.id", ondelete="SET NULL"), nullable=True, index=True)
    visit_id      = Column(Integer, ForeignKey("visits.id",   ondelete="SET NULL"), nullable=True)

    detected_at   = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    # VisionFlow track timing (video-relative seconds; optional)
    t_enter_sec   = Column(Float, nullable=True)
    t_exit_sec    = Column(Float, nullable=True)
    duration_sec  = Column(Float, nullable=True)
    # Shop presence timer (Live/Paused/Done) — authoritative show duration
    presence_duration_sec = Column(Float, nullable=True)

    # Relationships
    vehicle = relationship("Vehicle", foreign_keys=[vehicle_id])
    visit   = relationship("Visit", back_populates="anpr_detections", foreign_keys=[visit_id])
