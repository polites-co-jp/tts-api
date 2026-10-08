from __future__ import annotations

import io

import numpy as np
import soundfile as sf

# エンジンが返すのは wav と pcm（16bit リトルエンディアン・モノラル）だけ。他の形式は api が変換する
FORMATS = {"wav": "audio/wav", "pcm": "audio/pcm"}


def to_int16(audio: np.ndarray) -> np.ndarray:
    clipped = np.clip(audio.astype(np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2")


def encode(audio: np.ndarray, sample_rate: int, fmt: str) -> bytes:
    if fmt == "pcm":
        return to_int16(audio).tobytes()
    if fmt == "wav":
        buf = io.BytesIO()
        sf.write(buf, to_int16(audio), sample_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    raise ValueError(f"unsupported response_format: {fmt}")
