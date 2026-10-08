from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .catalog import ModelSpec
from .config import Settings

logger = logging.getLogger(__name__)

# options で受け付ける Irodori の推論パラメータと、その型
SAMPLING_OPTIONS: dict[str, type] = {
    "num_steps": int,
    "cfg_scale_text": float,
    "cfg_scale_caption": float,
    "cfg_scale_speaker": float,
    "cfg_guidance_mode": str,
    "cfg_min_t": float,
    "cfg_max_t": float,
    "duration_scale": float,
    "max_seconds": float,
    "t_schedule_mode": str,
    "sway_coeff": float,
    "truncation_factor": float,
    "speaker_kv_scale": float,
    "trim_tail": bool,
}


class OutOfMemory(RuntimeError):
    pass


@dataclass
class SegmentRequest:
    text: str
    references: list[Path]
    caption: str | None
    speed: float
    seed: int
    watermark: bool
    sampling: dict[str, Any] = field(default_factory=dict)


@dataclass
class SegmentResult:
    audio: np.ndarray  # float32・モノラル
    sample_rate: int
    seed: int
    messages: list[str] = field(default_factory=list)


class LoadedModel(Protocol):
    def capabilities(self) -> dict[str, bool]: ...

    def synthesize(self, req: SegmentRequest) -> SegmentResult: ...

    def unload(self) -> None: ...


class Backend(Protocol):
    def load(self, spec: ModelSpec) -> LoadedModel: ...

    def reset_peak_memory(self) -> None: ...

    def memory(self) -> dict[str, float] | None: ...


def new_seed() -> int:
    return int(secrets.randbits(31))


# ---------------------------------------------------------------------------
# 偽の推論器: 文字数に比例した長さの正弦波を返す。GPU も重みも使わない


class FakeModel:
    sample_rate = 48000

    def __init__(self, spec: ModelSpec) -> None:
        self.spec = spec
        self.calls: list[SegmentRequest] = []

    def capabilities(self) -> dict[str, bool]:
        return {"reference": True, "caption": True}

    def synthesize(self, req: SegmentRequest) -> SegmentResult:
        self.calls.append(req)
        seconds = max(0.2, 0.08 * len(req.text)) / req.speed
        t = np.arange(int(seconds * self.sample_rate), dtype=np.float32) / self.sample_rate
        freq = 220.0 + (req.seed % 220)
        audio = (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        return SegmentResult(audio=audio, sample_rate=self.sample_rate, seed=req.seed)

    def unload(self) -> None:
        pass


class FakeBackend:
    def __init__(self) -> None:
        self.loaded: list[str] = []
        self.fail_on_load: set[str] = set()

    def load(self, spec: ModelSpec) -> FakeModel:
        if spec.id in self.fail_on_load:
            raise OutOfMemory(f"fake out of memory while loading {spec.id}")
        self.loaded.append(spec.id)
        return FakeModel(spec)

    def reset_peak_memory(self) -> None:
        pass

    def memory(self) -> dict[str, float] | None:
        return None


# ---------------------------------------------------------------------------
# Irodori-TTS 本体を使う推論器。torch と irodori_tts は Docker イメージにだけ入っている


class _NoWatermark:
    ready = False

    def encode_batch(self, audios, *, sample_rate):  # noqa: ANN001
        return audios


class IrodoriModel:
    def __init__(self, runtime: Any, backend: IrodoriBackend) -> None:
        self.runtime = runtime
        self.backend = backend
        self.watermarker = runtime.watermarker

    def capabilities(self) -> dict[str, bool]:
        cfg = self.runtime.model_cfg
        return {
            "reference": bool(cfg.use_speaker_condition_resolved),
            "caption": bool(cfg.use_caption_condition),
        }

    def synthesize(self, req: SegmentRequest) -> SegmentResult:
        from irodori_tts.inference_runtime import SamplingRequest

        sampling = dict(req.sampling)
        duration_scale = float(sampling.pop("duration_scale", 1.0)) / req.speed
        latents = [str(self.backend.reference_latent(self.runtime, path)) for path in req.references]
        sampling_req = SamplingRequest(
            text=req.text,
            caption=req.caption,
            ref_latents=latents or None,
            no_ref=not latents,
            duration_scale=duration_scale,
            seed=req.seed,
            **sampling,
        )
        self.runtime.watermarker = self.watermarker if req.watermark else _NoWatermark()
        try:
            result = self.backend.run_guarded(lambda: self.runtime.synthesize(sampling_req))
        finally:
            self.runtime.watermarker = self.watermarker
        audio = result.audio.detach().float().cpu()
        mono = audio.mean(dim=0) if audio.ndim == 2 else audio.reshape(-1)
        messages = [m for m in result.messages if "watermark is unavailable" not in m or req.watermark]
        return SegmentResult(
            audio=mono.numpy().astype(np.float32),
            sample_rate=int(result.sample_rate),
            seed=int(result.used_seed),
            messages=messages,
        )

    def unload(self) -> None:
        self.runtime.unload()
        self.runtime = None
        self.backend.empty_cache()


class IrodoriBackend:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.settings.latent_cache_dir.mkdir(parents=True, exist_ok=True)

    def load(self, spec: ModelSpec) -> IrodoriModel:
        from irodori_tts.inference_runtime import (
            InferenceRuntime,
            RuntimeKey,
            download_hf_checkpoint,
        )

        checkpoint = download_hf_checkpoint(spec.checkpoint)
        key = RuntimeKey(
            checkpoint=checkpoint,
            model_device=self.settings.model_device,
            model_precision=self.settings.model_precision,
            codec_device=self.settings.codec_device,
            codec_precision=self.settings.codec_precision,
            compile_model=self.settings.compile_model,
        )
        runtime = self.run_guarded(lambda: InferenceRuntime.from_key(key))
        return IrodoriModel(runtime, self)

    def run_guarded(self, fn):  # noqa: ANN001, ANN201
        import torch

        try:
            return fn()
        except torch.OutOfMemoryError as exc:
            self.empty_cache()
            raise OutOfMemory(str(exc)) from exc

    def empty_cache(self) -> None:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def reset_peak_memory(self) -> None:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()

    def memory(self) -> dict[str, float] | None:
        import torch

        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        mib = 1024 * 1024
        return {
            "vram_peak_mb": round(torch.cuda.max_memory_allocated() / mib, 1),
            "vram_reserved_mb": round(torch.cuda.memory_reserved() / mib, 1),
            "gpu_used_mb": round((total - free) / mib, 1),
            "gpu_total_mb": round(total / mib, 1),
        }

    def reference_latent(self, runtime: Any, path: Path) -> Path:
        """参照音声を codec で潜在表現にし、ファイルへキャッシュする。長文の分割ごとに符号化し直さない。"""
        import torch
        from irodori_tts.inference_runtime import _load_audio

        stat = path.stat()
        key = f"{runtime.key.codec_repo}|{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
        cached = self.settings.latent_cache_dir / f"{hashlib.sha256(key.encode()).hexdigest()}.pt"
        if cached.is_file():
            return cached
        wav, sr = _load_audio(path)
        max_seconds = float(runtime.default_max_ref_seconds)
        if max_seconds > 0:
            wav = wav[:, : max(1, int(max_seconds * float(sr)))]
        latent = runtime.codec.encode_waveform(
            wav.unsqueeze(0),
            sample_rate=int(sr),
            normalize_db=-16.0,
            ensure_max=True,
        ).cpu()
        tmp = cached.with_suffix(".tmp")
        torch.save(latent[0].contiguous(), tmp)
        tmp.replace(cached)
        return cached


def create_backend(settings: Settings) -> Backend:
    if settings.backend == "fake":
        return FakeBackend()
    if settings.backend == "irodori":
        return IrodoriBackend(settings)
    raise ValueError(f"unknown ENGINE_BACKEND: {settings.backend}")
