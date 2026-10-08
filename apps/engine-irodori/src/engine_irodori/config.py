from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else raw.strip()


@dataclass(frozen=True)
class Settings:
    # irodori: 本物の推論器 / fake: GPU を使わない偽の推論器（テストと api・chat の動作確認用）
    backend: str = "irodori"
    default_model: str = "irodori-v4.1-small"
    preload: bool = True
    model_device: str = "cuda"
    model_precision: str = "bf16"
    codec_device: str = "cuda"
    codec_precision: str = "fp32"
    compile_model: bool = False
    # 透かし（SilentCipher）の既定。リクエストの options.watermark で上書きできる
    watermark: bool = True
    # 参照音声として受け付けるのはこのディレクトリ配下のファイルだけ（api と共有する声の置き場）
    voices_dir: Path = Path("/data/voices")
    latent_cache_dir: Path = Path("/tmp/engine-latents")

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            backend=_str("ENGINE_BACKEND", cls.backend),
            default_model=_str("ENGINE_DEFAULT_MODEL", cls.default_model),
            preload=_bool("ENGINE_PRELOAD", cls.preload),
            model_device=_str("ENGINE_MODEL_DEVICE", cls.model_device),
            model_precision=_str("ENGINE_MODEL_PRECISION", cls.model_precision),
            codec_device=_str("ENGINE_CODEC_DEVICE", cls.codec_device),
            codec_precision=_str("ENGINE_CODEC_PRECISION", cls.codec_precision),
            compile_model=_bool("ENGINE_COMPILE_MODEL", cls.compile_model),
            watermark=_bool("ENGINE_WATERMARK", cls.watermark),
            voices_dir=Path(_str("ENGINE_VOICES_DIR", str(cls.voices_dir))),
            latent_cache_dir=Path(_str("ENGINE_LATENT_CACHE_DIR", str(cls.latent_cache_dir))),
        )
