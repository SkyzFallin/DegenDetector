import asyncio
from datetime import datetime, timezone
from collections import deque
from .config import settings

class Engine:
    def __init__(self):
        self._stop = asyncio.Event()

    async def run(self):
        while True:
            await asyncio.sleep(5)