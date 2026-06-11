"""Serialize User ORM rows for API responses with effective page permissions."""

from __future__ import annotations

from ..models.user import User
from ..schemas.user import UserOut
from ..services.permissions import effective_pages, parse_stored_pages


def serialize_user_out(user: User) -> UserOut:
    custom = parse_stored_pages(getattr(user, "allowed_pages", None))
    return UserOut(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        username=user.username,
        role=user.role,
        phone=user.phone,
        avatar_url=user.avatar_url,
        is_active=user.is_active,
        last_login=user.last_login,
        created_at=user.created_at,
        allowed_pages=effective_pages(user),
        custom_page_permissions=custom,
    )
