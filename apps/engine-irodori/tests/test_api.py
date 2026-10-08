from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from engine_irodori.app import create_app
from engine_irodori.backends import FakeBackend
from engine_irodori.config import Settings


@pytest.fixture
def voices_dir(tmp_path: Path) -> Path:
    root = tmp_path / "voices"
    (root / "alice").mkdir(parents=True)
    sf.write(root / "alice" / "ref.wav", [0.0] * 4800, 48000)
    return root


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def client(voices_dir: Path, backend: FakeBackend):  # noqa: ANN201
    settings = Settings(backend="fake", preload=False, voices_dir=voices_dir)
    with TestClient(create_app(settings, backend)) as c:
        yield c


def sse_events(body: str) -> list[dict]:
    return [json.loads(line[len("data: ") :]) for line in body.splitlines() if line.startswith("data: ")]


def test_health_reports_engine(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["engine"] == "irodori"
    assert res.json()["loaded_model"] is None


def test_models_list_includes_all_families(client: TestClient) -> None:
    ids = [m["id"] for m in client.get("/v1/models").json()["data"]]
    assert "irodori-v4.1-small" in ids
    assert "irodori-v4.1-small-mf" in ids
    assert "irodori-v4-large-int4-weight-only" in ids
    assert "irodori-v4-small-float8-dynamic" in ids
    assert len(ids) == 19


def test_speech_returns_wav_with_metrics(client: TestClient) -> None:
    res = client.post("/v1/audio/speech", json={"input": "こんにちは。今日はいい天気です。"})
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    data, sr = sf.read(io.BytesIO(res.content))
    assert sr == 48000
    assert len(data) > 0
    metrics = json.loads(res.headers["x-tts-metrics"])
    assert metrics["model"] == "irodori-v4.1-small"
    assert metrics["segments"] == 2
    assert metrics["model_load_ms"] >= 0
    assert metrics["rtf"] is not None


def test_same_seed_is_used_for_every_segment(client: TestClient, backend: FakeBackend) -> None:
    res = client.post("/v1/audio/speech", json={"input": "一つ目の文です。二つ目の文です。"})
    assert res.status_code == 200
    seed = json.loads(res.headers["x-tts-metrics"])["seed"]
    model = client.app.state.slot.model
    assert [call.seed for call in model.calls] == [seed, seed]


def test_switching_model_unloads_previous(client: TestClient, backend: FakeBackend) -> None:
    client.post("/v1/audio/speech", json={"input": "テストです。"})
    res = client.post("/v1/audio/speech", json={"input": "テストです。", "model": "irodori-v4.1-small-mf"})
    assert res.status_code == 200
    assert backend.loaded == ["irodori-v4.1-small", "irodori-v4.1-small-mf"]
    statuses = {m["id"]: m["status"] for m in client.get("/v1/models").json()["data"]}
    assert statuses["irodori-v4.1-small-mf"] == "loaded"
    assert statuses["irodori-v4.1-small"] == "available"


def test_unknown_model_is_404(client: TestClient) -> None:
    res = client.post("/v1/audio/speech", json={"input": "テスト", "model": "nope"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "model_not_found"


def test_unknown_option_is_400(client: TestClient) -> None:
    res = client.post("/v1/audio/speech", json={"input": "テスト", "options": {"num_stepz": 4}})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "unknown_option"


def test_options_are_passed_to_backend(client: TestClient) -> None:
    res = client.post(
        "/v1/audio/speech",
        json={
            "input": "テストの文です。",
            "speed": 1.5,
            "options": {"num_steps": 8, "cfg_scale_text": 2.5, "seed": 42, "caption": "明るい声", "watermark": False},
        },
    )
    assert res.status_code == 200
    call = client.app.state.slot.model.calls[0]
    assert call.sampling == {"num_steps": 8, "cfg_scale_text": 2.5}
    assert call.seed == 42
    assert call.caption == "明るい声"
    assert call.watermark is False
    assert call.speed == 1.5


def test_reference_must_be_inside_voices_dir(client: TestClient, voices_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.wav"
    sf.write(outside, [0.0] * 480, 48000)
    res = client.post("/v1/audio/speech", json={"input": "テスト", "references": [str(outside)]})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "reference_not_found"

    ok = client.post(
        "/v1/audio/speech", json={"input": "テスト", "references": [str(voices_dir / "alice" / "ref.wav")]}
    )
    assert ok.status_code == 200
    assert client.app.state.slot.model.calls[0].references == [(voices_dir / "alice" / "ref.wav").resolve()]


def test_load_out_of_memory_returns_503_and_empties_slot(client: TestClient, backend: FakeBackend) -> None:
    client.post("/v1/audio/speech", json={"input": "テストです。"})
    backend.fail_on_load.add("irodori-v4-large")
    res = client.post("/v1/audio/speech", json={"input": "テストです。", "model": "irodori-v4-large"})
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "insufficient_vram"
    health = client.get("/health").json()
    assert health["loaded_model"] is None
    assert "out of memory" in health["last_error"]


def test_sse_streams_segments_then_done(client: TestClient) -> None:
    res = client.post(
        "/v1/audio/speech",
        json={"input": "一つ目。二つ目の文。三つ目の文です。", "stream_format": "sse"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = sse_events(res.text)
    deltas = [e for e in events if e["type"] == "speech.audio.delta"]
    assert [d["segment"]["index"] for d in deltas] == list(range(len(deltas)))
    assert len(deltas) == deltas[0]["segment"]["count"]
    data, sr = sf.read(io.BytesIO(base64.b64decode(deltas[0]["audio"])))
    assert sr == 48000
    done = events[-1]
    assert done["type"] == "speech.audio.done"
    assert done["metrics"]["segments"] == len(deltas)
    assert done["metrics"]["first_audio_ms"] <= done["metrics"]["total_ms"]


def test_sse_reports_load_error_as_event(client: TestClient, backend: FakeBackend) -> None:
    backend.fail_on_load.add("irodori-v4-large")
    res = client.post(
        "/v1/audio/speech", json={"input": "テスト", "model": "irodori-v4-large", "stream_format": "sse"}
    )
    events = sse_events(res.text)
    assert events == [
        {"type": "error", "error": {"message": events[0]["error"]["message"], "type": "server_error", "code": "insufficient_vram"}}
    ]


def test_pcm_format(client: TestClient) -> None:
    res = client.post("/v1/audio/speech", json={"input": "テスト", "response_format": "pcm"})
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/pcm"
    assert res.headers["x-tts-sample-rate"] == "48000"
    assert len(res.content) % 2 == 0


def test_preload_loads_default_model(voices_dir: Path) -> None:
    backend = FakeBackend()
    settings = Settings(backend="fake", preload=True, voices_dir=voices_dir)
    with TestClient(create_app(settings, backend)) as c:
        c.post("/v1/audio/speech", json={"input": "テスト"})
    assert backend.loaded == ["irodori-v4.1-small"]


def test_sse_sends_keepalive_while_waiting(voices_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    import engine_irodori.app as app_module

    class SlowBackend(FakeBackend):
        def load(self, spec):  # noqa: ANN001, ANN201
            time.sleep(0.35)
            return super().load(spec)

    monkeypatch.setattr(app_module, "KEEPALIVE_SECONDS", 0.1)
    settings = Settings(backend="fake", preload=False, voices_dir=voices_dir)
    with TestClient(create_app(settings, SlowBackend())) as c:
        res = c.post("/v1/audio/speech", json={"input": "テスト", "stream_format": "sse"})
    assert ": keepalive" in res.text
    assert sse_events(res.text)[-1]["type"] == "speech.audio.done"
