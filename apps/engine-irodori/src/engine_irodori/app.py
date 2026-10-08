from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import audio
from .backends import (
    SAMPLING_OPTIONS,
    Backend,
    OutOfMemory,
    SegmentRequest,
    SegmentResult,
    create_backend,
    new_seed,
)
from .catalog import MODELS, MODELS_BY_ID
from .config import Settings
from .slot import ModelLoadError, ModelSlot
from .text import split_segments

logger = logging.getLogger(__name__)

ENGINE_NAME = "irodori"
# 分割した文と文の間に挟む無音
SEGMENT_GAP_SECONDS = 0.12


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str, type_: str = "invalid_request_error") -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.type = type_


def error_body(message: str, code: str, type_: str = "invalid_request_error") -> dict[str, Any]:
    return {"error": {"message": message, "type": type_, "code": code}}


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str = Field(min_length=1, max_length=5000)
    # 参照音声のパス（api と共有する声の置き場の中）。空なら参照なしで生成する
    references: list[str] = Field(default_factory=list, max_length=16)
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    response_format: Literal["wav", "pcm"] = "wav"
    stream_format: Literal["audio", "sse"] = "audio"
    options: dict[str, Any] = Field(default_factory=dict)


class ParsedOptions(BaseModel):
    caption: str | None = None
    seed: int | None = None
    watermark: bool | None = None
    sampling: dict[str, Any] = Field(default_factory=dict)


def parse_options(raw: dict[str, Any]) -> ParsedOptions:
    parsed = ParsedOptions()
    for name, value in raw.items():
        if value is None:
            continue
        if name == "caption":
            parsed.caption = str(value).strip() or None
        elif name == "seed":
            parsed.seed = _coerce(name, value, int)
        elif name == "watermark":
            parsed.watermark = _coerce(name, value, bool)
        elif name in SAMPLING_OPTIONS:
            parsed.sampling[name] = _coerce(name, value, SAMPLING_OPTIONS[name])
        else:
            allowed = ", ".join(sorted(["caption", "seed", "watermark", *SAMPLING_OPTIONS]))
            raise ApiError(400, f"未知のオプション {name!r}。使えるのは {allowed}", "unknown_option")
    return parsed


def _coerce(name: str, value: Any, kind: type) -> Any:
    if kind is bool:
        if isinstance(value, bool):
            return value
        raise ApiError(400, f"options.{name} は真偽値で指定してください", "invalid_option")
    if kind in (int, float):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ApiError(400, f"options.{name} は数値で指定してください", "invalid_option")
        if kind is int and not float(value).is_integer():
            raise ApiError(400, f"options.{name} は整数で指定してください", "invalid_option")
        return kind(value)
    if not isinstance(value, str):
        raise ApiError(400, f"options.{name} は文字列で指定してください", "invalid_option")
    return value


def create_app(settings: Settings | None = None, backend: Backend | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    backend = backend or create_backend(settings)
    if settings.default_model not in MODELS_BY_ID:
        raise ValueError(f"ENGINE_DEFAULT_MODEL が一覧にありません: {settings.default_model}")
    slot = ModelSlot(backend)

    async def preload() -> None:
        async with slot.request_lock:
            try:
                await slot.run(lambda: slot.ensure_sync(settings.default_model))
            except ModelLoadError as exc:
                logger.error("preload failed: %s", exc)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(preload()) if settings.preload else None
        yield
        if task is not None:
            task.cancel()
        slot.shutdown()

    app = FastAPI(title="engine-irodori", lifespan=lifespan)
    app.state.slot = slot
    app.state.settings = settings

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(error_body(exc.message, exc.code, exc.type), status_code=exc.status)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unexpected error")
        return JSONResponse(error_body(f"内部エラー: {exc}", "internal_error", "server_error"), status_code=500)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {"msg": "invalid request"}
        loc = ".".join(str(part) for part in first.get("loc", []) if part != "body")
        return JSONResponse(
            error_body(f"{loc}: {first.get('msg')}" if loc else str(first.get("msg")), "invalid_request"),
            status_code=400,
        )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "engine": ENGINE_NAME,
            "backend": settings.backend,
            "loaded_model": slot.model_id,
            "loading_model": slot.loading_id,
            "last_error": slot.last_error,
        }

    @app.get("/v1/models")
    async def list_models() -> dict[str, Any]:
        capabilities = slot.model.capabilities() if slot.model is not None else None
        data = []
        for spec in MODELS:
            if spec.id == slot.model_id:
                status = "loaded"
            elif spec.id == slot.loading_id:
                status = "loading"
            else:
                status = "available"
            data.append(
                {
                    "id": spec.id,
                    "object": "model",
                    "owned_by": ENGINE_NAME,
                    "engine": ENGINE_NAME,
                    "family": spec.family,
                    "description": spec.description,
                    "checkpoint": spec.checkpoint,
                    "license": spec.license,
                    "weights_gb": spec.weights_gb,
                    "default": spec.id == settings.default_model,
                    "status": status,
                    "capabilities": capabilities if status == "loaded" else None,
                }
            )
        return {"object": "list", "data": data}

    def resolve_references(paths: list[str]) -> list[Path]:
        root = settings.voices_dir.resolve()
        resolved = []
        for raw in paths:
            path = Path(raw).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ApiError(400, f"参照音声が見つかりません: {raw}", "reference_not_found")
            resolved.append(path)
        return resolved

    @app.post("/v1/audio/speech")
    async def speech(req: SpeechRequest) -> Response:
        received = time.perf_counter()
        model_id = req.model or settings.default_model
        if model_id not in MODELS_BY_ID:
            raise ApiError(404, f"モデル {model_id!r} はありません", "model_not_found")
        opts = parse_options(req.options)
        references = resolve_references(req.references)
        segments = split_segments(req.input)
        if not segments:
            raise ApiError(400, "input が空です", "empty_input")
        seed = opts.seed if opts.seed is not None else new_seed()
        watermark = settings.watermark if opts.watermark is None else opts.watermark

        def segment_request(text: str) -> SegmentRequest:
            return SegmentRequest(
                text=text,
                references=references,
                caption=opts.caption,
                speed=req.speed,
                seed=seed,
                watermark=watermark,
                sampling=dict(opts.sampling),
            )

        run = SynthesisRun(slot, backend, model_id, received)

        if req.stream_format == "sse":
            return StreamingResponse(
                sse_events(run, segments, segment_request, req.response_format, seed),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        async with slot.request_lock:
            try:
                await run.start()
                results = [await run.segment(segment_request(text)) for text in segments]
            except ModelLoadError as exc:
                raise load_error(exc) from exc
            except OutOfMemory as exc:
                raise ApiError(503, f"合成中に VRAM が足りなくなりました: {exc}", "insufficient_vram", "server_error") from exc
            except ValueError as exc:
                raise ApiError(400, str(exc), "invalid_request") from exc
            metrics = await run.finish(results, seed)
        sample_rate = results[0].sample_rate
        joined = join_segments([r.audio for r in results], sample_rate)
        return Response(
            content=audio.encode(joined, sample_rate, req.response_format),
            media_type=audio.FORMATS[req.response_format],
            headers={
                "X-TTS-Sample-Rate": str(sample_rate),
                "X-TTS-Metrics": json.dumps(metrics, ensure_ascii=True, separators=(",", ":")),
            },
        )

    return app


def load_error(exc: ModelLoadError) -> ApiError:
    if exc.out_of_memory:
        return ApiError(503, str(exc), "insufficient_vram", "server_error")
    return ApiError(502, str(exc), "model_load_failed", "server_error")


def join_segments(parts: list[np.ndarray], sample_rate: int) -> np.ndarray:
    gap = np.zeros(int(SEGMENT_GAP_SECONDS * sample_rate), dtype=np.float32)
    pieces: list[np.ndarray] = []
    for i, part in enumerate(parts):
        if i > 0:
            pieces.append(gap)
        pieces.append(part)
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


class SynthesisRun:
    """1リクエスト分の合成と計測。request_lock を持った状態で呼ぶ。"""

    def __init__(self, slot: ModelSlot, backend: Backend, model_id: str, received: float) -> None:
        self.slot = slot
        self.backend = backend
        self.model_id = model_id
        self.received = received
        self.started = 0.0
        self.load_ms = 0.0
        self.synthesis_ms = 0.0
        self.first_audio_ms: float | None = None

    async def start(self) -> None:
        self.started = time.perf_counter()
        self.load_ms = await self.slot.run(lambda: self.slot.ensure_sync(self.model_id))
        await self.slot.run(self.backend.reset_peak_memory)

    async def segment(self, req: SegmentRequest) -> SegmentResult:
        model = self.slot.model
        if model is None:
            raise ModelLoadError(self.model_id, "モデルが読み込まれていません", out_of_memory=False)
        t0 = time.perf_counter()
        result = await self.slot.run(lambda: model.synthesize(req))
        self.synthesis_ms += (time.perf_counter() - t0) * 1000.0
        if self.first_audio_ms is None:
            self.first_audio_ms = (time.perf_counter() - self.received) * 1000.0
        return result

    async def finish(self, results: list[SegmentResult], seed: int) -> dict[str, Any]:
        memory = await self.slot.run(self.backend.memory)
        sample_rate = results[0].sample_rate if results else 0
        audio_seconds = sum(len(r.audio) for r in results) / sample_rate if sample_rate else 0.0
        audio_seconds += SEGMENT_GAP_SECONDS * max(0, len(results) - 1)
        metrics: dict[str, Any] = {
            "model": self.model_id,
            "queue_ms": round((self.started - self.received) * 1000.0, 1),
            "model_load_ms": round(self.load_ms, 1),
            "first_audio_ms": round(self.first_audio_ms or 0.0, 1),
            "synthesis_ms": round(self.synthesis_ms, 1),
            "total_ms": round((time.perf_counter() - self.received) * 1000.0, 1),
            "audio_seconds": round(audio_seconds, 3),
            "rtf": round((self.synthesis_ms / 1000.0) / audio_seconds, 4) if audio_seconds else None,
            "segments": len(results),
            "seed": seed,
            "sample_rate": sample_rate,
        }
        if memory is not None:
            metrics.update(memory)
        return metrics


def sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"


async def sse_events(
    run: SynthesisRun,
    segments: list[str],
    segment_request: Callable[[str], SegmentRequest],
    fmt: str,
    seed: int,
) -> AsyncIterator[str]:
    async with run.slot.request_lock:
        results: list[SegmentResult] = []
        try:
            await run.start()
            for index, text in enumerate(segments):
                result = await run.segment(segment_request(text))
                results.append(result)
                yield sse(
                    {
                        "type": "speech.audio.delta",
                        "audio": base64.b64encode(audio.encode(result.audio, result.sample_rate, fmt)).decode(),
                        "segment": {
                            "index": index,
                            "count": len(segments),
                            "text": text,
                            "audio_seconds": round(len(result.audio) / result.sample_rate, 3),
                            "sample_rate": result.sample_rate,
                            "messages": result.messages,
                        },
                    }
                )
        except ModelLoadError as exc:
            err = load_error(exc)
            yield sse({"type": "error", **error_body(err.message, err.code, err.type)})
            return
        except OutOfMemory as exc:
            message = f"合成中に VRAM が足りなくなりました: {exc}"
            yield sse({"type": "error", **error_body(message, "insufficient_vram", "server_error")})
            return
        except ValueError as exc:
            yield sse({"type": "error", **error_body(str(exc), "invalid_request")})
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("synthesis failed")
            yield sse({"type": "error", **error_body(f"合成に失敗しました: {exc}", "synthesis_failed", "server_error")})
            return
        metrics = await run.finish(results, seed)
        yield sse({"type": "speech.audio.done", "metrics": metrics})
