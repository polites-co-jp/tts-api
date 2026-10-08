# tts-api 設計

オープンウェイトの TTS をローカル GPU で動かし、OpenAI 互換の API として提供する。最初のエンジンは Irodori-TTS。
動作確認用に、文を入れて読み上げるだけの chat 画面を付ける。

決定日: 2026-10-08（grill-me による設計の詰め）

## 前提

- GPU は RTX 5060 Ti 16GB（Blackwell / sm_120）。CUDA 12.8 以降の PyTorch が要る。
- Windows のデスクトップアプリが約 3.8GB を使う。ai-hub（`E:\develop\local-ai-hub`）は TTS を使うときに止めるので、それ以外の約 12GB を TTS に使ってよい。ai-hub 側の設定（`OLLAMA_KEEP_ALIVE` など）は変えない。

## 構成

```
apps/
  api/              Fastify (TypeScript)。外向き API、エンジンへの振り分け、声の保管
  chat/             Fastify (TypeScript) ＋素の HTML/JS。動作確認用画面（profile dev のみ）
  engine-irodori/   Python。Irodori-TTS 本体ライブラリを使う自作エンジン
docs/
tts-api-containers/ docker-compose.yml など
```

- TTS ごとに専用のエンジンコンテナを作る。torch や CUDA の版が TTS ごとに食い違っても衝突しない。
- どのエンジンも同じ内部契約（下記）を話す。新しい TTS はエンジンコンテナを足し、api の設定に登録するだけで済む。
- 複数エンジン間の GPU 調停（片方を解放させてから振り分ける等）は今回は作らない。2つ目のエンジンを足すときに決める。

## 外向き API（api）

OpenAI 互換に、エンジン固有の指定を入れる `options` を足す。認証はなし、`127.0.0.1` にだけ公開する。

- `POST /v1/audio/speech`
  - `model`: 例 `irodori-v4.1-small`。省略時は既定モデル
  - `input`: 読み上げる文
  - `voice`: 登録した声の ID。省略すると参照なしで生成する
  - `response_format`: `wav` / `mp3` / `opus` / `flac` / `pcm`（wav 以外は ffmpeg で変換）
  - `speed`
  - `stream_format`: `"sse"` のとき OpenAI と同じ形のイベント（`speech.audio.delta` / `speech.audio.done`）で文ごとに送る。省略時は結合した音声を一括で返す
  - `options`: エンジン固有。Irodori では `num_steps`、`cfg_scale_text`、`cfg_scale_speaker`、`seed`、`caption`（音声デザイン）、`watermark`
- `GET /v1/models`: 全エンジンのモデル一覧（読み込み済みかどうかを含む）
- `GET /v1/voices` / `POST /v1/voices`（multipart で参照音声をアップロード）/ `DELETE /v1/voices/{id}`
- 応答には計測値を付ける（ヘッダーまたは SSE の done イベント）: モデル読込時間、最初の音までの時間、全体の生成時間、RTF、VRAM 使用量

## 声

- 参照音声によるクローン、キャプションによる音声デザイン、参照なしの3通りを最初から入れる。プリセット声は同梱しない。
- 声は api がボリュームへ一括保管する（音声ファイル＋メタデータ）。エンジンへは読み取り専用で共有し、どのエンジンでも同じ声 ID が使える。
- モデルごとの参照音声の潜在表現は、各エンジンが自分でキャッシュする。

## エンジン（engine-irodori）

- 公式の Irodori-TTS-Server は1プロセス1チェックポイントで実行中の切り替えができないため使わない。本体ライブラリ（github.com/Aratako/Irodori-TTS、コミットを固定）を直接使う。
- 起動時に既定モデル（v4.1-Small）を読み込む。別のモデルが要求されたら、今のモデルを解放してから読み込む（1枠）。待機中も解放しない。
- 合成は1件ずつ順番に処理する。
- モデルの読み込みで VRAM が溢れたらエラーを返し、枠を空にする。
- 長文は「。！？」と改行で分割して生成する。
- 透かし（SilentCipher）は既定で有効、環境変数とリクエストの `options.watermark` で切れる。
- ホストへは公開しない。

### 切り替え候補のモデル

重みは初めて選ばれたときに取得する。

| 系統 | チェックポイント |
|---|---|
| v4.1-Small（既定） | `Aratako/Irodori-TTS-v4.1-Small`、`-MF`、`-Quantized` の int8-weight-only / int8-dynamic / int4-weight-only / float8-weight-only / float8-dynamic |
| v4-Large | `Aratako/Irodori-TTS-v4-Large`（bf16 で読む）、`-Quantized` の5種 |
| v4-Small | `Aratako/Irodori-TTS-v4-Small`、`-Quantized` |

旧版（500M v2/v3、VoiceDesign v2 / 600M-v3）は入れない。v4-Large の重みは Gemma 利用規約。

### 内部契約（エンジンが実装するもの）

外向き API と同じ形の `POST /v1/audio/speech` と `GET /v1/models` に、`GET /health` を加える。声は api から参照音声のパスで渡す。

## chat

文の入力、モデル・声の選択、再生に加えて次を入れる。

- 速度と VRAM の計測表示（最初の音まで、全体、RTF、モデル読込、VRAM）
- 推論オプションの調整欄（ステップ数、CFG、seed、話速、透かし）
- 声の登録・削除と、キャプションの入力
- 生成履歴と聞き比べ・ダウンロード（ブラウザ内に保持）

SSE を使い、最初の文から再生を始める。

## ポート

予約レンジは **22500-22599**（Notion「ポート管理」へは実装時に登録し、`docs/port-registry.md` に写しを置く）。

| ポート | サービス | 既定バインド |
|---|---|---|
| 22500 | api | 127.0.0.1 |
| 22501 | chat（profile dev のみ） | 127.0.0.1 |
| 非公開 | engine-irodori | compose 内ネットワークのみ |

## 重みの置き場

ホストのディレクトリ（`.env` の `HF_CACHE_DIR`、既定 `E:/hf-cache`）をエンジンへマウントする。全モデルを試すと 40GB を超える。

## 検証

- api / chat: vitest。typecheck を通す。
- engine: pytest。GPU を使わない偽の推論器で契約を検証する。
- 実機での確認は compose で起動し、chat から各モデルを生成して計測値を見る。
