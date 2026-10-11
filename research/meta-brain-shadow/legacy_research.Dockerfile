FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 EXECUTION_ENABLED=false SHADOW_ONLY=true DATA_ROOT=/capture PORT=8080 RESEARCH_PORT=8081
ENV MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app
ARG GIT_COMMIT
RUN python -c "import re; assert re.fullmatch('[0-9a-f]{40}', '${GIT_COMMIT}'), 'Supply verified overlay GIT_COMMIT build argument'"
# The original observer checks its immutable boundary against this original revision.
# The separate overlay revision records the actual additional image sources honestly.
ENV RESEARCH_REVISION=${GIT_COMMIT} GIT_COMMIT=6b99b620435717bc360d3d9b5ca4d42b88f6ffef
LABEL org.opencontainers.image.revision=${RESEARCH_REVISION}
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/livez')"
CMD ["python", "research_launcher.py"]
