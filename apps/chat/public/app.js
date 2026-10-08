// TTS 動作確認画面。/api/* は chat サーバーが tts-api へ中継する
const $ = (id) => document.getElementById(id);

const SEGMENT_GAP_SECONDS = 0.12;
const NUMBER_OPTIONS = ["num_steps", "cfg_scale_text", "cfg_scale_speaker", "cfg_scale_caption"];

const state = {
  models: [],
  voices: [],
  abort: null,
  audioCtx: null,
  sources: [],
  history: [],
};

// ---------------------------------------------------------------------------
// API

async function apiJson(path, init) {
  const res = await fetch(`/api${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function loadModels() {
  const body = await apiJson("/v1/models");
  state.models = body.data ?? [];
  renderModels();
}

async function loadVoices() {
  const body = await apiJson("/v1/voices");
  state.voices = body.data ?? [];
  renderVoices();
}

async function loadHealth() {
  const el = $("engine-status");
  try {
    const body = await apiJson("/health");
    const loaded = state.models.find((m) => m.status === "loaded");
    const loading = state.models.find((m) => m.status === "loading");
    const engines = body.engines.map((e) => `${e.name}${e.reachable ? "" : "（接続できません）"}`).join(", ");
    const now = loading ? `読み込み中: ${loading.id}` : loaded ? `読み込み済み: ${loaded.id}` : "モデル未読み込み";
    el.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = `dot ${body.status === "ok" ? "ok" : "warn"}`;
    el.append(dot, `エンジン ${engines} ／ ${now}`);
  } catch (err) {
    el.textContent = `api に接続できません: ${err.message}`;
  }
}

async function refreshStatus() {
  try {
    await loadModels();
  } catch {
    // health 側で表示する
  }
  await loadHealth();
}

// ---------------------------------------------------------------------------
// 表示

function modelLabel(m) {
  const status = m.status === "loaded" ? "● " : m.status === "loading" ? "… " : "";
  const size = m.weights_gb ? ` ${m.weights_gb}GB` : "";
  return `${status}${m.id}${size}`;
}

function renderModels() {
  const select = $("model");
  const current = select.value || state.models.find((m) => m.default)?.id;
  select.innerHTML = "";
  const groups = new Map();
  for (const m of state.models) {
    const key = `${m.engine} / ${m.family ?? "other"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const [label, models] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const m of models) group.append(new Option(modelLabel(m), m.id, false, m.id === current));
    select.append(group);
  }

  const list = $("compare-models");
  const checked = new Set([...list.querySelectorAll("input:checked")].map((i) => i.value));
  list.innerHTML = "";
  for (const m of state.models) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = m.id;
    box.checked = checked.has(m.id);
    label.append(box, modelLabel(m));
    list.append(label);
  }
  renderModelInfo();
}

function renderModelInfo() {
  const m = state.models.find((x) => x.id === $("model").value);
  $("model-info").textContent = m
    ? `${m.description ?? ""}　ライセンス: ${m.license ?? "不明"}${m.status === "loaded" ? "　（読み込み済み）" : "　（選ぶと読み込みます。初回は重みを取得します）"}`
    : "";
}

function renderVoices() {
  const select = $("voice");
  const current = select.value;
  select.innerHTML = "";
  select.append(new Option("参照なし（モデル任せ）", "none"));
  for (const v of state.voices) select.append(new Option(`${v.name}（${v.id}・${v.duration_seconds.toFixed(1)}秒）`, v.id, false, v.id === current));

  const list = $("voices");
  list.innerHTML = "";
  for (const v of state.voices) {
    const li = document.createElement("li");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = v.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${v.id} ・ ${v.duration_seconds.toFixed(1)}秒${v.transcript ? ` ・ 「${v.transcript}」` : ""}`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `/api/v1/voices/${encodeURIComponent(v.id)}/audio`;
    const tools = document.createElement("div");
    tools.className = "tools";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      if (!confirm(`声「${v.name}」を削除しますか？`)) return;
      try {
        await apiJson(`/v1/voices/${encodeURIComponent(v.id)}`, { method: "DELETE" });
        await loadVoices();
      } catch (err) {
        showError("voice-error", err.message);
      }
    });
    tools.append(del);
    li.append(name, meta, audio, tools);
    list.append(li);
  }
}

const METRIC_LABELS = [
  ["client_first_audio_ms", "最初の音まで（画面）", "ms"],
  ["first_audio_ms", "最初の音まで（エンジン）", "ms"],
  ["model_load_ms", "モデル読込", "ms"],
  ["queue_ms", "待ち", "ms"],
  ["synthesis_ms", "生成時間", "ms"],
  ["total_ms", "全体", "ms"],
  ["audio_seconds", "音声の長さ", "秒"],
  ["rtf", "RTF（生成時間÷音声長）", ""],
  ["vram_peak_mb", "VRAM ピーク", "MB"],
  ["vram_reserved_mb", "VRAM 確保", "MB"],
  ["gpu_used_mb", "GPU 全体の使用", "MB"],
  ["host_rss_mb", "メインメモリ（エンジン）", "MB"],
  ["segments", "分割数", ""],
  ["seed", "seed", ""],
];

function formatMetric(value, unit) {
  if (value === undefined || value === null) return "—";
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(2)} 秒` : `${Math.round(value)} ms`;
  if (unit === "MB") return `${Math.round(value).toLocaleString()} MB`;
  if (unit === "秒") return `${Number(value).toFixed(2)} 秒`;
  return String(value);
}

function renderMetrics(metrics) {
  const dl = $("metrics");
  dl.innerHTML = "";
  for (const [key, label, unit] of METRIC_LABELS) {
    if (!(key in metrics)) continue;
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = key === "gpu_used_mb" && metrics.gpu_total_mb ? `${formatMetric(metrics[key], unit)} / ${formatMetric(metrics.gpu_total_mb, unit)}` : formatMetric(metrics[key], unit);
    div.append(dt, dd);
    dl.append(div);
  }
}

function summary(metrics) {
  const parts = [];
  if (metrics.model_load_ms) parts.push(`読込 ${formatMetric(metrics.model_load_ms, "ms")}`);
  if (metrics.client_first_audio_ms !== undefined) parts.push(`初音 ${formatMetric(metrics.client_first_audio_ms, "ms")}`);
  if (metrics.synthesis_ms !== undefined) parts.push(`生成 ${formatMetric(metrics.synthesis_ms, "ms")}`);
  if (metrics.audio_seconds !== undefined) parts.push(`音声 ${formatMetric(metrics.audio_seconds, "秒")}`);
  if (metrics.rtf !== undefined && metrics.rtf !== null) parts.push(`RTF ${metrics.rtf}`);
  if (metrics.vram_peak_mb !== undefined) parts.push(`VRAM ${formatMetric(metrics.vram_peak_mb, "MB")}`);
  if (metrics.seed !== undefined) parts.push(`seed ${metrics.seed}`);
  return parts.join(" ・ ");
}

function showError(id, message) {
  const el = $(id);
  el.hidden = !message;
  el.textContent = message ?? "";
}

// ---------------------------------------------------------------------------
// 音声: エンジンの wav（16bit PCM）を直接読む。履歴用の wav も元のサンプルレートのまま組み立てる

function parseWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("wav ではありません");
  let offset = 12;
  let sampleRate = 48000;
  let channels = 1;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      const len = Math.min(size, bytes.length - offset - 8);
      const samples = new Int16Array(bytes.slice(offset + 8, offset + 8 + len - (len % 2)).buffer);
      return { sampleRate, channels, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("wav に data がありません");
}

function buildWav(chunks, sampleRate) {
  const gap = Math.round(SEGMENT_GAP_SECONDS * sampleRate);
  const total = chunks.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, chunks.length - 1);
  const buf = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buf);
  const write = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, total * 2, true);
  const out = new Int16Array(buf, 44);
  let pos = 0;
  chunks.forEach((c, i) => {
    if (i > 0) pos += gap;
    out.set(c, pos);
    pos += c.length;
  });
  return new Blob([buf], { type: "audio/wav" });
}

function audioContext() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  if (state.audioCtx.state === "suspended") void state.audioCtx.resume();
  return state.audioCtx;
}

function stopPlayback() {
  for (const s of state.sources) {
    try {
      s.stop();
    } catch {
      // 再生前・再生後の stop は無視してよい
    }
  }
  state.sources = [];
}

/** 文ごとの音声を途切れなく続けて鳴らす */
function createPlayer() {
  let nextAt = 0;
  return (wav) => {
    const ctx = audioContext();
    const buffer = ctx.createBuffer(1, wav.samples.length, wav.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < wav.samples.length; i++) data[i] = wav.samples[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.05, nextAt);
    source.start(startAt);
    nextAt = startAt + buffer.duration + SEGMENT_GAP_SECONDS;
    state.sources.push(source);
  };
}

// ---------------------------------------------------------------------------
// 生成

function readSettings() {
  const options = {};
  for (const name of NUMBER_OPTIONS) {
    const raw = $(name).value.trim();
    if (raw !== "") options[name] = Number(raw);
  }
  const caption = $("caption").value.trim();
  if (caption) options.caption = caption;
  const seed = $("seed").value.trim();
  if (seed !== "") options.seed = Number(seed);
  options.watermark = $("watermark").checked;
  return {
    input: $("text").value.trim(),
    voice: $("voice").value,
    speed: Number($("speed").value) || 1,
    options,
  };
}

async function synthesize(model, settings, signal) {
  const started = performance.now();
  const res = await fetch("/api/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, ...settings, response_format: "wav", stream_format: "sse" }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }

  const play = $("autoplay").checked ? createPlayer() : null;
  const chunks = [];
  let sampleRate = 48000;
  let clientFirstAudioMs;
  let metrics = {};
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!raw.startsWith("data: ")) continue;
      const event = JSON.parse(raw.slice(6));
      if (event.type === "error") throw new Error(event.error?.message ?? "生成に失敗しました");
      if (event.type === "speech.audio.delta") {
        clientFirstAudioMs ??= performance.now() - started;
        const bytes = Uint8Array.from(atob(event.audio), (c) => c.charCodeAt(0));
        const wav = parseWav(bytes);
        sampleRate = wav.sampleRate;
        chunks.push(wav.samples);
        play?.(wav);
        const seg = event.segment;
        $("progress").textContent = `${model}: ${seg.index + 1} / ${seg.count} 文目 「${seg.text}」`;
      } else if (event.type === "speech.audio.done") {
        metrics = event.metrics ?? {};
      }
    }
  }
  if (chunks.length === 0) throw new Error("音声が返ってきませんでした");
  return { blob: buildWav(chunks, sampleRate), metrics: { ...metrics, client_first_audio_ms: Math.round(clientFirstAudioMs) } };
}

async function generate() {
  const settings = readSettings();
  if (!settings.input) {
    showError("error", "読み上げる文を入れてください");
    return;
  }
  const models = $("compare").checked ? [...$("compare-models").querySelectorAll("input:checked")].map((i) => i.value) : [$("model").value];
  if (models.length === 0) {
    showError("error", "比較するモデルを選んでください");
    return;
  }
  // 比較のときは同じ seed で揃える（参照なしでは seed で声が決まるため）
  if (models.length > 1 && settings.options.seed === undefined) settings.options.seed = Math.floor(Math.random() * 2 ** 31);

  showError("error", "");
  stopPlayback();
  audioContext();
  state.abort = new AbortController();
  $("generate").disabled = true;
  $("stop").disabled = false;
  const errors = [];
  try {
    for (const model of models) {
      $("progress").textContent = `${model}: 準備中（未読み込みならモデルを読み込みます）…`;
      void refreshStatus();
      try {
        const { blob, metrics } = await synthesize(model, settings, state.abort.signal);
        renderMetrics(metrics);
        await addHistory({ model, settings, metrics, blob });
      } catch (err) {
        if (state.abort.signal.aborted) throw err;
        errors.push(`${model}: ${err.message}`);
      }
      await refreshStatus();
    }
    $("progress").textContent = errors.length ? "" : "完了しました";
  } catch (err) {
    $("progress").textContent = state.abort.signal.aborted ? "停止しました" : "";
    if (!state.abort.signal.aborted) errors.push(err.message);
  } finally {
    showError("error", errors.join("\n"));
    $("generate").disabled = false;
    $("stop").disabled = true;
    state.abort = null;
    void refreshStatus();
  }
}

// ---------------------------------------------------------------------------
// 履歴（IndexedDB。使えないブラウザではこのページを開いている間だけ保持する）

const DB_NAME = "tts-chat";
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("history", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function dbRun(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction("history", mode);
      const req = fn(tx.objectStore("history"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function addHistory({ model, settings, metrics, blob }) {
  const voice = state.voices.find((v) => v.id === settings.voice);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    model,
    voice: voice ? voice.name : "参照なし",
    text: settings.input,
    options: settings.options,
    speed: settings.speed,
    metrics,
    blob,
  };
  state.history.unshift(entry);
  await dbRun("readwrite", (store) => store.put(entry));
  renderHistory();
}

async function loadHistory() {
  const all = (await dbRun("readonly", (store) => store.getAll())) ?? [];
  state.history = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderHistory();
}

const urls = new Map();
function blobUrl(entry) {
  if (!urls.has(entry.id)) urls.set(entry.id, URL.createObjectURL(entry.blob));
  return urls.get(entry.id);
}

function renderHistory() {
  const list = $("history");
  list.innerHTML = "";
  for (const entry of state.history) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "head";
    const model = document.createElement("span");
    model.className = "model";
    model.textContent = entry.model;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = `${entry.voice} ・ ${new Date(entry.createdAt).toLocaleString()}`;
    head.append(model, when);
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = entry.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    const opts = Object.entries(entry.options ?? {})
      .filter(([k]) => k !== "seed")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    meta.textContent = [summary(entry.metrics ?? {}), opts, entry.speed !== 1 ? `speed=${entry.speed}` : ""].filter(Boolean).join(" ・ ");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = blobUrl(entry);
    const tools = document.createElement("div");
    tools.className = "tools";
    const download = document.createElement("a");
    download.href = blobUrl(entry);
    download.download = `${entry.model}-${entry.createdAt.replace(/[:.]/g, "-")}.wav`;
    download.textContent = "ダウンロード";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      state.history = state.history.filter((e) => e.id !== entry.id);
      await dbRun("readwrite", (store) => store.delete(entry.id));
      URL.revokeObjectURL(urls.get(entry.id));
      urls.delete(entry.id);
      renderHistory();
    });
    tools.append(download, del);
    li.append(head, text, meta, audio, tools);
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// 声の登録

async function registerVoice(event) {
  event.preventDefault();
  showError("voice-error", "");
  const file = $("voice-file").files[0];
  if (!file) return;
  const form = new FormData();
  for (const [field, id] of [["id", "voice-id"], ["name", "voice-name"], ["transcript", "voice-transcript"]]) {
    const value = $(id).value.trim();
    if (value) form.append(field, value);
  }
  form.append("file", file);
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const voice = await apiJson("/v1/voices", { method: "POST", body: form });
    $("voice-form").reset();
    await loadVoices();
    $("voice").value = voice.id;
  } catch (err) {
    showError("voice-error", err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------

$("generate").addEventListener("click", () => void generate());
$("stop").addEventListener("click", () => {
  state.abort?.abort();
  stopPlayback();
});
$("compare").addEventListener("change", () => {
  $("compare-list").hidden = !$("compare").checked;
  $("model").disabled = $("compare").checked;
});
$("model").addEventListener("change", renderModelInfo);
$("voice-form").addEventListener("submit", (e) => void registerVoice(e));
$("clear-history").addEventListener("click", async () => {
  if (!confirm("履歴をすべて消しますか？")) return;
  state.history = [];
  await dbRun("readwrite", (store) => store.clear());
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  renderHistory();
});

void (async () => {
  await Promise.allSettled([refreshStatus(), loadVoices(), loadHistory()]);
})();
// 読み込み状況を数秒ごとに更新する（別のタブや API からの生成でモデルが入れ替わることがある）
setInterval(() => {
  if (!state.abort) void refreshStatus();
}, 5000);
