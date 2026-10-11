FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 EXECUTION_ENABLED=false SHADOW_ONLY=true DATA_ROOT=/capture PORT=8080 RESEARCH_PORT=8081
ENV MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072
WORKDIR /app
COPY research/meta-brain-shadow/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY research/meta-brain-shadow/ /app/
# This packaging recipe preserves every byte sealed in the completed reset.
# Fail during the build, rather than at service startup, for missing evidence.
RUN python -c "import json,hashlib,pathlib; m=json.loads(pathlib.Path('decision_build_manifest.json').read_text()); [(_ for _ in ()).throw(RuntimeError('Missing or changed sealed file: '+n)) for n,h in m['files'].items() if not pathlib.Path(n).is_file() or hashlib.sha256(pathlib.Path(n).read_bytes()).hexdigest()!=h]; print('PASS: all sealed runtime/model/config/qualification files included')"
ARG GIT_COMMIT
RUN python -c "import re; assert re.fullmatch('[0-9a-f]{40}', '${GIT_COMMIT}')"
ENV RESEARCH_REVISION=${GIT_COMMIT} GIT_COMMIT=6b99b620435717bc360d3d9b5ca4d42b88f6ffef
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/livez')"
CMD ["python", "decision_launcher.py"]
