FROM python:3.12-slim-bookworm AS dependencies

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential libgeos-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY tools/population/requirements.txt ./tools/population/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
        --requirement tools/population/requirements.txt

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libexpat1 libgeos-c1v5 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /opt/venv /opt/venv

COPY tools/population/engine.py tools/population/service.py tools/population/tile_index.py ./tools/population/

RUN useradd --create-home --uid 10001 worldrawing \
    && mkdir -p /var/lib/worldrawing/tile-index \
    && chown -R worldrawing:worldrawing /var/lib/worldrawing

USER worldrawing
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/ready', timeout=2).read()"]

CMD ["python", "tools/population/service.py"]
