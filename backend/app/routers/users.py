from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from ..database import get_db
from ..models.user import User, UserRole
from ..schemas.user import UserCreate, UserUpdate, UserOut, PagePermissionsMeta, UserRosterOut
from ..utils.auth import hash_password, get_current_user, require_admin, require_manager, require_page
from ..utils.user_out import serialize_user_out
from ..services.permissions import (
    ALL_PAGE_KEYS,
    PAGE_LABELS,
    DEFAULT_PAGES_BY_ROLE,
    dump_stored_pages,
    can_access_page,
)

router = APIRouter(prefix="/api/users", tags=["Users"])


def _apply_user_update(user: User, data: UserUpdate) -> dict:
    update_data = data.model_dump(exclude_unset=True)
    if update_data.pop("use_role_default_pages", None):
        user.allowed_pages = None
    if "allowed_pages" in update_data:
        pages = update_data.pop("allowed_pages")
        user.allowed_pages = dump_stored_pages(pages)
    if "password" in update_data:
        update_data["hashed_password"] = hash_password(update_data.pop("password"))
    return update_data


@router.get("/page-permissions-meta", response_model=PagePermissionsMeta)
def page_permissions_meta(current_user: User = Depends(require_admin)):
    return PagePermissionsMeta(
        all_pages=[{"key": k, "label": PAGE_LABELS.get(k, k)} for k in ALL_PAGE_KEYS],
        role_defaults={role.value: pages for role, pages in DEFAULT_PAGES_BY_ROLE.items()},
    )


@router.get("/roster", response_model=List[UserRosterOut])
def staff_roster(db: Session = Depends(get_db), current_user: User = Depends(require_page("visits"))):
    """Minimal user list for work-order staff assignment (visits page only)."""
    rows = (
        db.query(User)
        .filter(User.is_active.is_(True), User.role.in_([UserRole.STAFF, UserRole.MANAGER, UserRole.ADMIN]))
        .order_by(User.full_name.asc())
        .all()
    )
    return [UserRosterOut(id=u.id, full_name=u.full_name, role=u.role, username=u.username) for u in rows]


@router.get("", response_model=List[UserOut])
def list_users(db: Session = Depends(get_db), current_user: User = Depends(require_manager)):
    return [serialize_user_out(u) for u in db.query(User).order_by(User.full_name.asc()).all()]


@router.post("", response_model=UserOut, status_code=201)
def create_user(data: UserCreate, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    if db.query(User).filter((User.username == data.username) | (User.email == data.email)).first():
        raise HTTPException(status_code=400, detail="Username or email already exists")
    payload = data.model_dump(exclude={"password", "allowed_pages"})
    user = User(**payload, hashed_password=hash_password(data.password))
    if data.allowed_pages is not None:
        user.allowed_pages = dump_stored_pages(data.allowed_pages)
    db.add(user)
    db.commit()
    db.refresh(user)
    return serialize_user_out(user)


@router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not can_access_page(current_user, "users") and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return serialize_user_out(user)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    update_data = _apply_user_update(user, data)
    for k, v in update_data.items():
        setattr(user, k, v)
    db.commit()
    db.refresh(user)
    return serialize_user_out(user)


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(user)
    db.commit()
