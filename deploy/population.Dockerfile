FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY tools/population/requirements.txt ./tools/population/requirements.txt
RUN pip install --no-cache-dir --requirement tools/population/requirements.txt

COPY tools/population/engine.py tools/population/service.py tools/population/tile_index.py ./tools/population/

RUN useradd --create-home --uid 10001 worldrawing \
    && mkdir -p /var/lib/worldrawing/tile-index \
    && chown -R worldrawing:worldrawing /var/lib/worldrawing

USER worldrawing
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/ready', timeout=2).read()"]

CMD ["python", "tools/population/service.py"]
