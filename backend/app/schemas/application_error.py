from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ApplicationErrorOut(BaseModel):
    id: int
    severity: str
    category: str
    source: str
    message: str
    detail: str | None = None
    stack_trace: str | None = None
    context: dict[str, Any] | None = None
    fingerprint: str | None = None
    occurrence_count: int = 1
    user_id: int | None = None
    job_id: str | None = None
    plate: str | None = None
    track_id: int | None = None
    ip_address: str | None = None
    resolved: bool = False
    resolved_at: datetime | None = None
    resolved_by: int | None = None
    last_seen_at: datetime | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class ErrorStatsOut(BaseModel):
    total: int
    unresolved: int
    last_24h: int
    by_category: dict[str, int]
    by_severity: dict[str, int]
    plate_monitoring: int


class ErrorResolveBody(BaseModel):
    resolved: bool = True


class ErrorIngestBody(BaseModel):
    """Optional server-side ingest (internal / tests)."""

    severity: str = Field(default="error", max_length=20)
    category: str = Field(..., max_length=40)
    source: str = Field(..., max_length=120)
    message: str = Field(..., max_length=8000)
    detail: str | None = Field(None, max_length=32000)
    stack_trace: str | None = Field(None, max_length=48000)
    context: dict[str, Any] | None = None
    job_id: str | None = Field(None, max_length=64)
    plate: str | None = Field(None, max_length=32)
    track_id: int | None = None
    fingerprint: str | None = Field(None, max_length=128)
