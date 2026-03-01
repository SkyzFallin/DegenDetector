from fastapi import APIRouter
from sqlalchemy import select, desc
from .db import SessionLocal
from .models import Alert

router = APIRouter()

@router.get("/alerts")
def list_alerts(limit: int = 50):
    with SessionLocal() as db:
        rows = db.execute(select(Alert).order_by(desc(Alert.created_at)).limit(limit)).scalars().all()
        return rows