FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml /app/
RUN pip install --no-cache-dir -U pip && pip install fastapi uvicorn sqlalchemy psycopg[binary] pydantic pydantic-settings redis websockets orjson cryptography httpx
COPY app /app/app
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]