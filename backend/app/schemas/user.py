from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional, List
from datetime import datetime
from ..models.user import UserRole


class UserBase(BaseModel):
    full_name: str
    email: EmailStr
    username: str
    role: UserRole = UserRole.STAFF
    phone: Optional[str] = None


class UserCreate(UserBase):
    password: str
    allowed_pages: Optional[List[str]] = None


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None
    allowed_pages: Optional[List[str]] = None
    use_role_default_pages: Optional[bool] = None


class UserOut(UserBase):
    id: int
    is_active: bool
    avatar_url: Optional[str] = None
    last_login: Optional[datetime] = None
    created_at: datetime
    allowed_pages: List[str] = []
    custom_page_permissions: Optional[List[str]] = None

    class Config:
        from_attributes = True


class UserLogin(BaseModel):
    username: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class PagePermissionsMeta(BaseModel):
    all_pages: List[dict]
    role_defaults: dict[str, List[str]]


class UserRosterOut(BaseModel):
    id: int
    full_name: str
    username: str
    role: UserRole

    class Config:
        from_attributes = True
