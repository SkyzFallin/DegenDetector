from sqlalchemy import String, Integer, Float, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from .db import Base

class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    venue: Mapped[str] = mapped_column(String)
    venue_market_id: Mapped[str] = mapped_column(String)
    outcome_id: Mapped[str] = mapped_column(String, nullable=True)
    alert_type: Mapped[str] = mapped_column(String, default="volume_spike")
    severity: Mapped[float] = mapped_column(Float)
    evidence: Mapped[dict] = mapped_column(JSON)