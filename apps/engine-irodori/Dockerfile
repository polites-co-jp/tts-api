# Irodori-TTS エンジン。torch の CUDA 版と Irodori-TTS 本体（コミット固定）を入れる。
#   TORCH_INDEX=cu128: NVIDIA GPU（既定。RTX 50 系の sm_120 も含む）
#   TORCH_INDEX=cpu  : GPU なし（遅い。動作確認なら ENGINE_BACKEND=fake のほうがよい）
# Irodori-TTS は torch 2.10 系に固定している（上流の pyproject.toml と同じ）。
ARG PYTHON_IMAGE=python:3.11-slim-trixie

FROM ${PYTHON_IMAGE} AS base
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# 偽の推論器だけで動く軽いイメージ。テストと、GPU なしで api・chat を確かめるのに使う
FROM base AS test
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install -e ".[dev]"
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q"]

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv --upgrade-deps /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

ARG TORCH_INDEX=cu128
ARG TORCH_VERSION=2.10.0
ARG IRODORI_COMMIT=89f9d8fbd4d51ea019867ee1197725ede1df13c5
ARG DACVAE_COMMIT=414c20785fc3a28373073ea8ef7a1316eeeaca6e
RUN pip install "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" \
        --index-url "https://download.pytorch.org/whl/${TORCH_INDEX}" \
    && pip install "torchao>=0.16.0,<0.17.0" "torchcodec>=0.10.0,<0.11.0" \
    && pip install "dacvae @ git+https://github.com/facebookresearch/dacvae@${DACVAE_COMMIT}" \
    && pip install "irodori-tts @ git+https://github.com/Aratako/Irodori-TTS@${IRODORI_COMMIT}"
COPY pyproject.toml /src/
COPY src /src/src
RUN pip install /src && pip check

FROM base AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    HF_HOME=/home/engine/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=8000
RUN groupadd --gid 10001 engine \
    && useradd --uid 10001 --gid engine --create-home engine \
    && mkdir -p /home/engine/.cache/huggingface \
    && chown -R engine:engine /home/engine/.cache
COPY --from=build /opt/venv /opt/venv
USER engine
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "engine_irodori"]
