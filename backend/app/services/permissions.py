"""Role defaults and per-user page permissions."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from sqlalchemy import or_

from ..models.user import UserRole

if TYPE_CHECKING:
    from sqlalchemy.orm import Query
    from ..models.user import User
    from ..models.visit import Visit

# Keys exposed to the frontend route guard
ALL_PAGE_KEYS: tuple[str, ...] = (
    "dashboard",
    "visits",
    "vehicles",
    "fleet",
    "services",
    "analytics",
    "visionflow",
    "visionflow_multicam",
    "users",
    "audit",
    "settings",
)

PAGE_LABELS: dict[str, str] = {
    "dashboard": "Dashboard",
    "visits": "Work orders / Visits",
    "vehicles": "Vehicles",
    "fleet": "Fleet intelligence",
    "services": "Services catalog",
    "analytics": "Analytics",
    "visionflow": "ANPR & speed",
    "visionflow_multicam": "Camera wall",
    "users": "Team users",
    "audit": "Audit log",
    "settings": "Settings",
}

DEFAULT_PAGES_BY_ROLE: dict[UserRole, list[str]] = {
    UserRole.ADMIN: list(ALL_PAGE_KEYS),
    UserRole.MANAGER: [k for k in ALL_PAGE_KEYS if k != "settings"],
    UserRole.STAFF: ["visits"],
    UserRole.VIEWER: ["dashboard", "visits", "vehicles"],
}


def parse_stored_pages(raw: str | None) -> list[str] | None:
    if raw is None or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            cleaned = [str(p) for p in data if str(p) in ALL_PAGE_KEYS]
            return cleaned
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def dump_stored_pages(pages: list[str] | None) -> str | None:
    if pages is None:
        return None
    cleaned = [p for p in pages if p in ALL_PAGE_KEYS]
    return json.dumps(cleaned)


def effective_pages(user: "User") -> list[str]:
    custom = parse_stored_pages(getattr(user, "allowed_pages", None))
    if custom is not None:
        return custom
    role = user.role if isinstance(user.role, UserRole) else UserRole(str(user.role))
    return list(DEFAULT_PAGES_BY_ROLE.get(role, ["visits"]))


def has_org_wide_access(user: "User") -> bool:
    role = user.role if isinstance(user.role, UserRole) else UserRole(str(user.role))
    return role in (UserRole.ADMIN, UserRole.MANAGER)


def can_access_page(user: "User", page_key: str) -> bool:
    return page_key in effective_pages(user)


def user_owns_visit(user: "User", visit: "Visit") -> bool:
    """Staff may only see visits they created or supervisor-signed."""
    if has_org_wide_access(user):
        return True
    uid = user.id
    return visit.created_by == uid or visit.supervisor_signed_by == uid


def apply_visit_scope(q: "Query", user: "User"):
    if has_org_wide_access(user):
        return q
    return q.filter(
        or_(
            Visit.created_by == user.id,
            Visit.supervisor_signed_by == user.id,
        )
    )


# Late import for Visit in apply_visit_scope
from ..models.visit import Visit  # noqa: E402
