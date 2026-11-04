FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MPLCONFIGDIR=/tmp/matplotlib YOLO_CONFIG_DIR=/tmp/ultralytics
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y gosu libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --upgrade pip==26.3 setuptools==84.2.1
RUN pip install --no-deps --index-url https://download.pytorch.org/whl/cpu torch==2.6.0 torchvision==0.21.0
COPY requirements.txt requirements.lock ./
RUN pip install -r requirements.txt -c requirements.lock
COPY app ./app
COPY config ./config
COPY migrations ./migrations
COPY docker-entrypoint.sh /usr/local/bin/woundmeter-entrypoint
RUN useradd --create-home --uid 10001 woundmeter && mkdir /app/data && chown woundmeter:woundmeter /app/data && chmod 0755 /usr/local/bin/woundmeter-entrypoint
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v2/health', timeout=4)"
ENTRYPOINT ["woundmeter-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
