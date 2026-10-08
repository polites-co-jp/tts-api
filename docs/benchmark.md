# モデルごとの実測（2026-10-08）

RTX 5060 Ti 16GB / Docker Desktop（WSL2）/ torch 2.10.0+cu128 / bf16 / 透かしあり / ステップ数はモデル既定（通常 40、MF は 4）。
文は「こんにちは。今日はいい天気ですね。少し散歩にでも出かけましょうか。」（3 文に分割）、seed=1、参照なし。

RTF は「生成時間 ÷ 音声の長さ」で、1 を超えると実時間より遅い。値は温まった状態（同じモデルで2回目）のもの。
VRAM はエンジンの PyTorch が確保したピーク（Windows のデスクトップが使う約 3GB は含まない）。

| モデル | RTF | 最初の音まで | VRAM ピーク |
|---|---|---|---|
| irodori-v4.1-small（既定） | 0.36 | 1.1 秒 | 2.7GB |
| irodori-v4.1-small-mf | 0.07〜0.10 | 0.3 秒 | 2.7GB |
| irodori-v4.1-small-int8-weight-only | 0.51 | 1.2 秒 | 2.1GB |
| irodori-v4.1-small-int8-dynamic | 6.29 | 19.0 秒 | 2.1GB |
| irodori-v4.1-small-int4-weight-only | 0.54 | 1.9 秒 | 2.0GB |
| irodori-v4.1-small-float8-weight-only | 0.56 | 1.8 秒 | 2.1GB |
| irodori-v4.1-small-float8-dynamic | 1.10 | 2.8 秒 | 2.1GB |
| irodori-v4-large | 0.71 | 2.4 秒 | 7.6GB |
| irodori-v4-large-int8-weight-only | 0.90 | 2.8 秒 | 5.0GB |
| irodori-v4-large-int8-dynamic | 8.97 | 30.4 秒 | 5.0GB |
| irodori-v4-large-int4-weight-only | 0.95 | 2.7 秒 | 4.1GB |
| irodori-v4-large-float8-weight-only | 1.32 | 4.1 秒 | 5.1GB |
| irodori-v4-large-float8-dynamic | 1.93 | 5.8 秒 | 5.0GB |
| irodori-v4-small | 0.36 | 1.1 秒 | 2.8GB |
| irodori-v4-small-int8-weight-only | 0.40 | 1.4 秒 | 2.2GB |
| irodori-v4-small-int8-dynamic | 5.62 | 19.1 秒 | 2.2GB |
| irodori-v4-small-int4-weight-only | 0.50 | 1.7 秒 | 2.1GB |
| irodori-v4-small-float8-weight-only | 0.51 | 1.7 秒 | 2.2GB |
| irodori-v4-small-float8-dynamic | 0.93 | 2.9 秒 | 2.2GB |

## 読み取れること

- この GPU では量子化しても速くならない。VRAM は Small で 0.6GB ほど、Large で 2.5〜3.5GB ほど減るが、RTF は非量子化より悪い。
- `int8-dynamic` は実時間の 6〜9 倍かかり、実用にならない。`float8-dynamic` も非量子化の 2〜3 倍遅い。
- 速さが要るなら v4.1-Small-MF。Large は bf16 で実時間よりやや速い（RTF 0.71）。
- 声の聞き比べ（品質）はここでは測っていない。chat の「複数モデルで比較」で同じ seed のまま聞き比べられる。

## 読み込み時間（重みを取得済みのとき）

名前付きボリュームから読む場合。起動直後の最初の読み込みは CUDA の初期化を含むので長い（v4.1-Small で 47 秒）。

| モデル | 読み込み |
|---|---|
| irodori-v4.1-small | 9 秒 |
| irodori-v4.1-small-mf | 15 秒 |
| irodori-v4-large-int8-weight-only | 27 秒 |
| irodori-v4-large | 41 秒 |

ホストのディレクトリ（9p 経由）から読んでいたときは、v4.1-Small で約 2.5 分、v4-Large で約 7 分かかった。

## メモリ

- エンジンのメインメモリ（RSS）は、モデルを GPU に載せたあと約 2〜3GB（CUDA と torch のライブラリ分）。v4-Large の読み込み中は一時的に約 10.6GB まで増える。
- v4-Large は読み込みの瞬間に VRAM を 13GB 以上使う（上流が fp32 のまま GPU に置いてから bf16 にするため）。読み込み後の確保量は 8.2GB。
