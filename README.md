# tts-api

オープンウェイトの TTS をローカル GPU で動かし、OpenAI 互換の API として提供する。最初のエンジンは [Irodori-TTS](https://github.com/Aratako/Irodori-TTS)。

- `apps/engine-irodori` — Irodori-TTS エンジン（Python）。19 のチェックポイントを1枠で入れ替える
- `apps/api` — 外向き API（Fastify）。モデル名でエンジンへ振り分け、声を保管し、形式を変換する
- `apps/chat` — 動作確認画面（profile `dev` のみ）
- `tts-api-containers` — docker compose 構成

設計と判断の経緯は [docs/design.md](docs/design.md)、ポートは [docs/port-registry.md](docs/port-registry.md)。

## 起動

```sh
cd tts-api-containers
cp .env.example .env   # 既定モデルやポートを必要に応じて変える
docker compose --profile dev up -d --build
```

- API: http://127.0.0.1:22500
- 動作確認画面: http://127.0.0.1:22501

起動すると既定モデル（`irodori-v4.1-small`）を読み込む。初回は重みの取得に数分かかる。重みは名前付きボリューム `tts-api_hf-cache` に溜まる（全モデルで 40GB 超）。
GPU なしで api と chat だけを確かめるときは、偽のエンジン（正弦波を返す）で起動する。

```sh
docker compose -f docker-compose.yml -f docker-compose.fake.yml --profile dev up -d --build
```

## 使い方

```sh
# モデル一覧（status: loaded / loading / available）
curl http://127.0.0.1:22500/v1/models

# 合成（OpenAI 互換）
curl http://127.0.0.1:22500/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"irodori-v4.1-small-mf","input":"こんにちは。","response_format":"mp3"}' -o out.mp3

# 声の登録（wav / mp3 / m4a など。1秒以上）
curl http://127.0.0.1:22500/v1/voices -F file=@me.m4a -F id=me -F name=自分の声
```

OpenAI SDK からは `base_url="http://127.0.0.1:22500/v1"` で呼べる（`api_key` は何でもよい）。

| 項目 | 内容 |
|---|---|
| `voice` | 登録した声の ID。`"none"` または省略で参照なし |
| `instructions` / `options.caption` | 声や話し方の説明（音声デザイン） |
| `response_format` | `wav` `pcm` `mp3` `opus` `aac` `flac` |
| `stream_format` | `"sse"` で文ごとに送る（`speech.audio.delta` / `speech.audio.done`） |
| `options` | `num_steps` `cfg_scale_text` `cfg_scale_speaker` `cfg_scale_caption` `seed` `watermark` など |

計測値は一括返却なら `X-TTS-Metrics` ヘッダ、SSE なら done イベントの `metrics` に入る。

## 開発

```sh
cd apps/api && npm ci && npm run typecheck && npm test
cd apps/chat && npm ci && npm run typecheck && npm test
cd apps/engine-irodori && pip install -e ".[dev]" && pytest    # 偽の推論器で動くので GPU は要らない
```

## 別の TTS を足すには

1. `apps/engine-<name>` を作り、[docs/design.md](docs/design.md) の「内部契約」を実装する
2. compose にサービスを足す（ホストへは公開しない。声のボリュームを `/data/voices` に読み取り専用でマウントする）
3. api の `ENGINES` に `<name>=http://engine-<name>:8000` を足す

GPU は1枚なので、エンジンを複数同時に動かすと VRAM を取り合う。エンジン間の調停はまだ作っていない。
