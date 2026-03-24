import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import plugin from "./index.ts";

function createHarness(pluginConfig = { defaultVoice: "Tingting", transcriptionBackend: "openclaw-runtime" }) {
  const routes = [];
  const transcribeCalls = [];
  plugin.register({
    id: "macos-say-tts",
    pluginConfig,
    config: {},
    runtime: {
      mediaUnderstanding: {
        async transcribeAudioFile(params) {
          transcribeCalls.push(params);
          return { text: "hello from openclaw" };
        },
      },
    },
    logger: {
      error() {},
      info() {},
    },
    registerHttpRoute(route) {
      routes.push(route);
    },
    registerCommand() {},
  });

  const speechRoute = routes.find((route) => route.path === "/v1/audio/speech");
  assert.ok(speechRoute, "speech route should be registered");
  const transcriptionRoute = routes.find((route) => route.path === "/v1/audio/transcriptions");
  assert.ok(transcriptionRoute, "transcription route should be registered");
  const healthRoute = routes.find((route) => route.path === "/plugins/macos-say-tts/health");
  assert.ok(healthRoute, "health route should be registered");
  const realtimeRoute = routes.find((route) => route.path === "/plugins/macos-say-tts/asr/realtime");
  assert.ok(realtimeRoute, "realtime route should be registered");

  async function invokeRoute(route, params) {
    const req = {
      method: params.method ?? "POST",
      url: params.url,
      headers: params.headers ?? {},
      async *[Symbol.asyncIterator]() {
        if (params.body !== undefined) {
          yield params.body;
        }
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      },
      end(chunk) {
        if (chunk) {
          this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        }
      },
    };

    await route.handler(req, res);
    const text = res.body.toString("utf8");
    const isJson = String(res.headers["content-type"] || "").includes("application/json");
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      text,
      json: isJson && res.body.length ? JSON.parse(text) : null,
    };
  }

  async function invokeSpeech(body) {
    return await invokeRoute(speechRoute, {
      url: "/v1/audio/speech",
      body: body !== undefined ? Buffer.from(body) : undefined,
    });
  }

  async function invokeTranscription({ form }) {
    const request = new Request("http://127.0.0.1/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const body = Buffer.from(await request.arrayBuffer());
    return await invokeRoute(transcriptionRoute, {
      url: "/v1/audio/transcriptions",
      body,
      headers: {
        "content-type": request.headers.get("content-type"),
        "content-length": String(body.length),
      },
    });
  }

  async function invokeHealth() {
    return await invokeRoute(healthRoute, {
      method: "GET",
      url: "/plugins/macos-say-tts/health",
    });
  }

  async function invokeRealtime(body) {
    return await invokeRoute(realtimeRoute, {
      method: "POST",
      url: "/plugins/macos-say-tts/asr/realtime",
      headers: {
        "content-type": "application/json",
      },
      body: Buffer.from(JSON.stringify(body)),
    });
  }

  return { invokeSpeech, invokeTranscription, invokeHealth, invokeRealtime, transcribeCalls };
}

test("returns 400 for invalid JSON request bodies", async () => {
  const { invokeSpeech } = createHarness();
  const response = await invokeSpeech("{bad json");

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(response.json, {
    error: { message: "Invalid JSON body." },
  });
});

test("returns 413 for oversized request bodies", async () => {
  const { invokeSpeech } = createHarness();
  const largeBody = "a".repeat(128 * 1024 + 1);
  const response = await invokeSpeech(largeBody);

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json, {
    error: { message: "Request body too large." },
  });
});

test("returns 400 for unsupported response formats", async () => {
  const { invokeSpeech } = createHarness();
  const response = await invokeSpeech(JSON.stringify({
    input: "hello",
    response_format: "mp3",
  }));

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Unsupported `response_format`. Use `wav`, `aiff`, or `opus`." },
  });
});

test("returns 400 when transcription upload is missing file", async () => {
  const { invokeTranscription } = createHarness();
  const form = new FormData();
  form.set("response_format", "text");

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Missing `file` upload." },
  });
});

test("returns text/plain transcription output for response_format=text", async () => {
  const { invokeTranscription, transcribeCalls } = createHarness();
  const form = new FormData();
  form.set("response_format", "text");
  form.set("file", new File([Buffer.from("RIFFfake")], "utterance.wav", { type: "audio/wav" }));

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.text, "hello from openclaw");
  assert.equal(transcribeCalls.length, 1);
  assert.equal(transcribeCalls[0].mime, "audio/wav");
});

test("returns 400 for unsupported transcription response formats", async () => {
  const { invokeTranscription } = createHarness();
  const form = new FormData();
  form.set("response_format", "srt");
  form.set("file", new File([Buffer.from("RIFFfake")], "utterance.wav", { type: "audio/wav" }));

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Unsupported `response_format`. Use `json`, `verbose_json`, or `text`." },
  });
});

test("health route reports realtime capability summary", async () => {
  const { invokeHealth } = createHarness({
    defaultVoice: "Tingting",
    transcriptionBackend: "doubao-realtime",
    doubaoAppId: "app",
    doubaoAccessToken: "token",
    doubaoWsUrl: "wss://example.invalid/asr",
    doubaoResourceId: "resource",
  });

  const response = await invokeHealth();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    ok: true,
    plugin: "macos-say-tts",
    speechPath: "/v1/audio/speech",
    transcriptionPath: "/v1/audio/transcriptions",
    realtimePath: "/plugins/macos-say-tts/asr/realtime",
    voice: "Tingting",
    realtimeEnabled: true,
    realtimeConfigured: true,
    realtimeBackend: "doubao-realtime",
  });
});

test("one-shot transcription falls back to runtime when doubao realtime backend is enabled", async () => {
  const { invokeTranscription, transcribeCalls } = createHarness({
    defaultVoice: "Tingting",
    transcriptionBackend: "doubao-realtime",
  });
  const form = new FormData();
  form.set("response_format", "json");
  form.set("file", new File([Buffer.from("RIFFfake")], "utterance.wav", { type: "audio/wav" }));

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { text: "hello from openclaw" });
  assert.equal(transcribeCalls.length, 1);
});

test("realtime route returns 409 when realtime backend is disabled", async () => {
  const { invokeRealtime } = createHarness({
    defaultVoice: "Tingting",
    transcriptionBackend: "openclaw-runtime",
  });

  const response = await invokeRealtime({
    type: "session.start",
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    channels: 1,
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json, {
    error: {
      message: "Realtime STT is disabled. Set `transcriptionBackend` to `doubao-realtime`.",
    },
  });
});

test("realtime route starts a session, forwards partials, and returns final text on commit", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.sent = [];
      this.opened = false;
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.opened = true;
        this.emit("open");
      });
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send(data) {
      this.sent.push(data);
      if (this.sent.length === 2) {
        queueMicrotask(() => {
          this.emit("message", {
            data: createDoubaoFullServerResponsePacket({
              code: 1000,
              sequence: 1,
              result: [{ text: "你好", utterances: [{ text: "你好，我想问", definite: false }] }],
            }),
          });
        });
      }
      if (this.sent.length === 3) {
        queueMicrotask(() => {
          this.emit("message", {
            data: createDoubaoFullServerResponsePacket({
              code: 1000,
              sequence: -1,
              result: [{ text: "你好，我想问一下。", utterances: [{ text: "你好，我想问一下。", definite: true }] }],
            }),
          });
        });
      }
    }

    close(code, reason) {
      this.closeCode = code;
      this.closeReason = reason;
    }

    emit(type, event = {}) {
      for (const listener of this.listeners[type]) {
        listener(event);
      }
    }
  }

  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const { invokeRealtime } = createHarness({
      defaultVoice: "Tingting",
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app-123",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoCluster: "streaming-asr",
    });

    const started = await invokeRealtime({
      type: "session.start",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      channels: 1,
      language: "zh",
      enable_partial: true,
    });

    assert.equal(started.statusCode, 200);
    assert.equal(started.json.chunk_ms, 100);
    assert.equal(started.json.events.length, 1);
    assert.equal(started.json.events[0].type, "session.started");
    const sessionId = started.json.session_id;
    assert.ok(sessionId);

    const appended = await invokeRealtime({
      type: "audio.append",
      session_id: sessionId,
      audio_base64: Buffer.from("abc").toString("base64"),
    });
    assert.equal(appended.statusCode, 200);
    assert.deepEqual(appended.json.events, [
      { type: "transcript.partial", text: "你好，我想问" },
    ]);

    const committed = await invokeRealtime({
      type: "session.commit",
      session_id: sessionId,
    });
    assert.equal(committed.statusCode, 200);
    assert.equal(committed.json.final_text, "你好，我想问一下。");
    assert.deepEqual(committed.json.events, [
      { type: "transcript.final", text: "你好，我想问一下。" },
      { type: "session.completed", finalText: "你好，我想问一下。" },
    ]);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0].binaryType, "arraybuffer");
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

function createDoubaoFullServerResponsePacket(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const compressed = Buffer.from(gzipSync(body));
  const header = Buffer.alloc(8);
  header[0] = 0x11;
  header[1] = 0x90;
  header[2] = 0x11;
  header[3] = 0x00;
  header.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([header, compressed]);
}
