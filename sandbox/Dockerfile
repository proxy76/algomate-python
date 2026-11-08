# Image used for every code execution. Build on the VM with:
#   docker build -t algomate-python-sandbox:latest sandbox/
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# Optional extra packages students may import (keep this list small: every
# package is reachable by untrusted code). Network is disabled at runtime, so
# anything not baked in here cannot be installed later.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY launcher.py /sandbox/launcher.py
RUN chmod 0555 /sandbox/launcher.py && mkdir -p /workspace && chmod 1777 /workspace

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    HOME=/tmp \
    WORKDIR=/workspace

USER 65534:65534
WORKDIR /workspace
ENTRYPOINT ["python", "/sandbox/launcher.py"]
