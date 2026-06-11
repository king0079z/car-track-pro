from datetime import UTC, datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from ..database import get_db
from ..models.user import User, UserRole
from ..services.permissions import can_access_page, has_org_wide_access
from ..config import settings

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


def require_manager(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in (UserRole.ADMIN, UserRole.MANAGER):
        raise HTTPException(status_code=403, detail="Manager access required")
    return current_user


def require_admin_or_manager(current_user: User = Depends(get_current_user)) -> User:
    return require_manager(current_user)


def require_page(page_key: str):
    """Dependency factory: user must have this page in their effective permissions."""

    def _dep(current_user: User = Depends(get_current_user)) -> User:
        if not can_access_page(current_user, page_key):
            raise HTTPException(status_code=403, detail=f"Access to '{page_key}' is not permitted")
        return current_user

    return _dep


def require_any_page(*page_keys: str):
    """User must have at least one of the listed pages."""

    def _dep(current_user: User = Depends(get_current_user)) -> User:
        if not any(can_access_page(current_user, k) for k in page_keys):
            raise HTTPException(status_code=403, detail="Access not permitted")
        return current_user

    return _dep


def require_org_wide(current_user: User = Depends(get_current_user)) -> User:
    if not has_org_wide_access(current_user):
        raise HTTPException(status_code=403, detail="Organization-wide access required")
    return current_user
