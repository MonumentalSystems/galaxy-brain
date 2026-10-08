FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN groupadd --system --gid 10001 galaxy \
    && useradd --system --uid 10001 --gid galaxy --home-dir /nonexistent --shell /usr/sbin/nologin galaxy

COPY --chown=galaxy:galaxy server.py worker.py ./

USER 10001:10001

EXPOSE 8043

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8043"]
