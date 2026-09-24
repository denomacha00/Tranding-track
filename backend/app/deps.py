"""FastAPI auth dependencies for multi-user mode.

Extracts the bearer token, validates it against SECRET_KEY, loads the user, and
enforces licensing/role. Kept separate from main.py so both the app routes and
tests can import them cleanly.
"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import LicenseStatus, User, UserRole
from app.security import decode_access_token


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from the Bearer token, or 401."""
    secret = get_settings().secret_key
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Server auth is not configured (SECRET_KEY unset).",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_access_token(secret, token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token subject")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return user


def require_licensed_user(user: User = Depends(get_current_user)) -> User:
    """Only users the admin has licensed may trade / configure keys."""
    if user.license_status != LicenseStatus.active.value:
        raise HTTPException(
            status_code=403,
            detail=(
                "Your account is not licensed yet. Ask the administrator to "
                "grant you a licence before trading."
            ),
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != UserRole.admin.value:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
