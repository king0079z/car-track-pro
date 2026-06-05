from pydantic import BaseModel, Field


class ClientAutoErrorCreate(BaseModel):
    """Automatically captured browser/runtime errors (no user action required)."""

    kind: str = Field(
        ...,
        max_length=40,
        description=(
            "uncaught | uncaught_cross_origin | unhandledrejection | chunk_load | react | console | "
            "console_warn | resource | csp | reporting_api | http_client | http_network | http_rate_limit | websocket"
        ),
    )
    message: str = Field(..., max_length=8000)
    stack: str | None = Field(None, max_length=48000)
    source: str | None = Field(None, max_length=2048)
    lineno: int | None = None
    colno: int | None = None
    page_path: str | None = Field(None, max_length=1024)
    href: str | None = Field(None, max_length=2048)
    component_stack: str | None = Field(None, max_length=16000)
    console_preview: str | None = Field(None, max_length=8000)
    fingerprint: str = Field(..., min_length=4, max_length=128)


class IncidentReportCreate(BaseModel):
    """User-reported application error / incident for audit trail & debugging."""

    summary: str = Field(..., min_length=4, max_length=240, description="Short headline shown in the timeline")
    details: str = Field(
        ...,
        min_length=12,
        max_length=32000,
        description="Steps to reproduce, expected vs actual, messages, etc.",
    )
    page_path: str | None = Field(None, max_length=512, description="Frontend route e.g. /visits/123")
