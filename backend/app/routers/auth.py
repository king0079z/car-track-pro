from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session
from datetime import UTC, datetime
from ..database import get_db
from ..models.user import User
from ..schemas.user import UserLogin, Token, UserCreate, UserOut
from ..utils.auth import verify_password, hash_password, create_access_token, get_current_user
from ..utils.user_out import serialize_user_out
from ..services.audit_service import create_audit_log

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


@router.post("/login", response_model=Token)
def login(request: Request, credentials: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == credentials.username).first()
    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

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
