import asyncio
from fastapi import FastAPI
from .db import Base, engine
from .api import router as api_router
from .engine import Engine

app = FastAPI(title="Spike Monitor")
app.include_router(api_router)

engine_obj = None

@app.on_event("startup")
async def startup():
    Base.metadata.create_all(bind=engine)
    global engine_obj
    engine_obj = Engine()
    asyncio.create_task(engine_obj.run())

@app.get("/health")
def health():
    return {"ok": True}