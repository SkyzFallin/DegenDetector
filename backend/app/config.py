from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://spike:spike@db:5432/spike"
    redis_url: str = "redis://redis:6379/0"

    poly_ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

    bin_seconds: int = 60
    baseline_bins: int = 360
    robust_z_thresh: float = 6.0
    min_contracts: float = 50.0
    cooldown_seconds: int = 300
    ewma_lambda: float = 0.2

settings = Settings()