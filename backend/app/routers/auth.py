import threading
import time

from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session
from datetime import UTC, datetime
from ..config import settings
from ..database import get_db
from ..models.user import User
from ..schemas.user import UserLogin, Token, UserCreate, UserOut
from ..utils.auth import verify_password, hash_password, create_access_token, get_current_user
from ..utils.user_out import serialize_user_out
from ..services.audit_service import create_audit_log

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


# ── Login rate limiting (brute-force protection) ──────────────────────────────
# In-memory failure tracking per (username, client IP). After
# ``max_login_attempts`` consecutive failures (Settings → Security, default 5)
# the pair is locked out for LOGIN_LOCKOUT_MINUTES. A successful login clears
# the counter. Stale entries are pruned opportunistically.

_login_fail: dict[tuple[str, str], tuple[int, float]] = {}  # key → (fails, last_fail_ts)
_login_fail_lock = threading.Lock()
_LOGIN_FAIL_WINDOW_SEC = 15 * 60.0


def _max_attempts() -> int:
    try:
        from .settings import _load

        return max(3, int(_load().get("max_login_attempts", 5)))
    except Exception:
        return 5


def _lockout_seconds() -> float:
    return max(60.0, float(getattr(settings, "LOGIN_LOCKOUT_MINUTES", 15.0)) * 60.0)


def _login_throttle_check(username: str, ip: str) -> float:
    """Seconds the caller must still wait, or 0 when allowed."""
    key = (username.lower(), ip)
    now = time.monotonic()
    with _login_fail_lock:
        # Opportunistic prune so the dict can't grow unbounded.
        if len(_login_fail) > 5000:
            stale = now - max(_LOGIN_FAIL_WINDOW_SEC, _lockout_seconds())
            for k in [k for k, (_, ts) in _login_fail.items() if ts < stale]:
                _login_fail.pop(k, None)
        entry = _login_fail.get(key)
        if not entry:
            return 0.0
        fails, last_ts = entry
        if now - last_ts > max(_LOGIN_FAIL_WINDOW_SEC, _lockout_seconds()):
            _login_fail.pop(key, None)
            return 0.0
        if fails >= _max_attempts():
            return max(0.0, _lockout_seconds() - (now - last_ts))
        return 0.0


def _login_record_failure(username: str, ip: str) -> None:
    key = (username.lower(), ip)
    now = time.monotonic()
    with _login_fail_lock:
        fails, _ = _login_fail.get(key, (0, now))
        _login_fail[key] = (fails + 1, now)


def _login_record_success(username: str, ip: str) -> None:
    with _login_fail_lock:
        _login_fail.pop((username.lower(), ip), None)


@router.post("/login", response_model=Token)
def login(request: Request, credentials: UserLogin, db: Session = Depends(get_db)):
    ip_addr = request.client.host if request.client else "?"
    wait = _login_throttle_check(credentials.username, ip_addr)
    if wait > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed sign-in attempts. Try again in {int(wait // 60) + 1} minute(s).",
            headers={"Retry-After": str(int(wait) + 1)},
        )

    user = db.query(User).filter(User.username == credentials.username).first()
    if not user or not verify_password(credentials.password, user.hashed_password):
        _login_record_failure(credentials.username, ip_addr)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

    _login_record_success(credentials.username, ip_addr)
    user.last_login = datetime.now(UTC)
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    create_audit_log(
        db,
        user_id=user.id,
        action="login",
        entity_type="user",
        entity_id=user.id,
        description=f"Sign-in: {user.username}",
        ip_address=ip,
        user_agent=ua[:2000] if ua else None,
        commit=False,
    )
    db.commit()

    token = create_access_token({"sub": user.username, "role": user.role})
    return Token(access_token=token, user=serialize_user_out(user))


@router.get("/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user)):
    return serialize_user_out(current_user)


@router.post("/register", response_model=UserOut, status_code=201)
def register_first_admin(data: UserCreate, db: Session = Depends(get_db)):
    existing = db.query(User).first()
    if existing:
        raise HTTPException(status_code=400, detail="Registration via this endpoint is disabled after initial setup")

    user = User(
        full_name=data.full_name,
        email=data.email,
        username=data.username,
        hashed_password=hash_password(data.password),
        role="admin",
        phone=data.phone,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return serialize_user_out(user)
