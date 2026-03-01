import asyncio
from .engine import Engine

async def main():
    eng = Engine()
    await eng.run()

if __name__ == "__main__":
    asyncio.run(main())
