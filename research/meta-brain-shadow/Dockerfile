FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 EXECUTION_ENABLED=false SHADOW_ONLY=true DATA_ROOT=/capture PORT=8080
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app
ARG GIT_COMMIT
RUN python -c "import re; assert re.fullmatch('[0-9a-f]{40}', '${GIT_COMMIT}'), 'Supply verified GIT_COMMIT build argument'"
ENV GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.revision=${GIT_COMMIT}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/livez')"
CMD ["python", "service.py"]
