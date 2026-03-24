import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  RealtimeSession,
  RealtimeSessionManager,
  createDoubaoAudioPacket,
  createDoubaoFullRequestPacket,
  createDoubaoRealtimeTransportFactory,
  decodeDoubaoPacket,
  getRealtimeCapability,
  isDoubaoRealtimeConfigured,
  mapDoubaoResponseToRealtimeEvents,
} from "./realtime.ts";

function createTransportHarness() {
  const connections = [];

  async function factory(params) {
    const handle = {
      params,
      chunks: [],
      committed: false,
      cancelled: false,
      closed: false,
      eventHandler: () => {},
      emit(event) {
        this.eventHandler(event);
      },
      connection: {
        setEventHandler(handler) {
          handle.eventHandler = handler;
        },
        async appendAudioChunk(chunk) {
          handle.chunks.push(chunk);
        },
        async commit() {
          handle.committed = true;
        },
        async cancel() {
          handle.cancelled = true;
        },
        async close() {
          handle.closed = true;
        },
      },
    };
    connections.push(handle);
    return handle.connection;
  }

  return {
    factory,
    connections,
  };
}

test("doubao realtime capability reports configured only when required fields are present", () => {
  assert.equal(
    isDoubaoRealtimeConfigured({
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app",
      doubaoAccessToken: "token",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoResourceId: "resource",
    }),
    true,
  );

  assert.equal(
    isDoubaoRealtimeConfigured({
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app",
      doubaoAccessToken: "",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoResourceId: "resource",
    }),
    false,
  );

  const capability = getRealtimeCapability({
    transcriptionBackend: "doubao-realtime",
    doubaoChunkMs: 120,
    doubaoEnableVad: true,
    doubaoVadStartSilenceMs: 700,
    doubaoVadEndSilenceMs: 900,
    realtimeSessionTimeoutSeconds: 180,
  });

  assert.deepEqual(capability, {
    backend: "doubao-realtime",
    enabled: true,
    configured: false,
    wsUrl: "",
    cluster: "",
    language: "",
    chunkMs: 120,
    enableVad: true,
    vadStartSilenceMs: 700,
    vadEndSilenceMs: 900,
    sessionTimeoutSeconds: 180,
    idleTimeoutSeconds: 15,
    maxAudioSeconds: 60,
  });
});

test("realtime session forwards partial and final transcript events", async () => {
  const transport = createTransportHarness();
  const manager = new RealtimeSessionManager(
    { transcriptionBackend: "doubao-realtime" },
    transport.factory,
  );
  const session = manager.createSession({
    audioFormat: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
    language: "zh",
    enablePartial: true,
  });
  const events = [];
  session.onEvent((event) => {
    events.push(event);
  });

  await session.start();
  await session.appendAudioBase64(Buffer.from("hello").toString("base64"));
  transport.connections[0].emit({ type: "partial", text: "你好，我想问" });
  transport.connections[0].emit({ type: "final", text: "你好，我想问一下。", utteranceId: "u1" });
  transport.connections[0].emit({ type: "completed" });
  const finalText = await session.commit();

  assert.equal(transport.connections.length, 1);
  assert.equal(transport.connections[0].params.language, "zh");
  assert.equal(transport.connections[0].chunks.length, 1);
  assert.equal(transport.connections[0].committed, true);
  assert.equal(session.bufferedPartialText, "");
  assert.equal(session.audioBytes, 5);
  assert.equal(finalText, "你好，我想问一下。");
  assert.deepEqual(events, [
    { type: "session.started", sessionId: session.id },
    { type: "transcript.partial", text: "你好，我想问", utteranceId: undefined },
    { type: "transcript.final", text: "你好，我想问一下。", utteranceId: "u1" },
    { type: "session.completed", finalText: "你好，我想问一下。" },
  ]);
});

test("realtime session propagates upstream errors to commit caller", async () => {
  const transport = createTransportHarness();
  const manager = new RealtimeSessionManager(
    { transcriptionBackend: "doubao-realtime" },
    transport.factory,
  );
  const session = manager.createSession({
    audioFormat: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });
  const events = [];
  session.onEvent((event) => {
    events.push(event);
  });

  await session.start();
  const commitPromise = session.commit();
  transport.connections[0].emit({
    type: "error",
    code: "upstream_timeout",
    message: "Upstream realtime ASR timed out.",
  });

  await assert.rejects(commitPromise, /Upstream realtime ASR timed out/);
  assert.deepEqual(events.at(-1), {
    type: "error",
    code: "upstream_timeout",
    message: "Upstream realtime ASR timed out.",
  });
});

test("session manager prunes expired sessions", async () => {
  const transport = createTransportHarness();
  const manager = new RealtimeSessionManager(
    {
      transcriptionBackend: "doubao-realtime",
      realtimeSessionTimeoutSeconds: 10,
    },
    transport.factory,
  );
  const session = manager.createSession({
    audioFormat: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
  });

  await session.start();
  const expiredIds = await manager.pruneExpiredSessions(session.lastTouchedAt + 11_000);

  assert.deepEqual(expiredIds, [session.id]);
  assert.equal(manager.size, 0);
  assert.equal(transport.connections[0].closed, true);
});

test("full request packet encodes doubao session settings", () => {
  const packet = createDoubaoFullRequestPacket({
    config: {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app-123",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoCluster: "streaming-asr",
      doubaoLanguage: "zh",
      doubaoEnableVad: true,
      doubaoVadStartSilenceMs: 700,
      doubaoVadEndSilenceMs: 900,
    },
    sessionId: "session-1",
    language: "zh",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const decoded = decodeDoubaoPacket(packet);
  const payload = JSON.parse(decoded.payload.toString("utf8"));

  assert.equal(decoded.messageType, 1);
  assert.equal(payload.app.appid, "app-123");
  assert.equal(payload.app.token, "token-456");
  assert.equal(payload.app.cluster, "streaming-asr");
  assert.equal(payload.audio.rate, 16000);
  assert.equal(payload.audio.bits, 16);
  assert.equal(payload.request.show_utterances, true);
  assert.equal(payload.request.result_type, "single");
  assert.equal(payload.request.vad_signal, true);
  assert.equal(payload.request.start_silence_time, 700);
  assert.equal(payload.request.vad_silence_time, 900);
});

test("bigmodel v3 request packet encodes official websocket payload fields", () => {
  const packet = createDoubaoFullRequestPacket({
    config: {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app-123",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      doubaoResourceId: "volc.bigasr.sauc.duration",
      doubaoLanguage: "zh",
      doubaoEnableVad: true,
      doubaoVadStartSilenceMs: 700,
      doubaoVadEndSilenceMs: 900,
    },
    sessionId: "session-v3",
    language: "zh",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const decoded = decodeDoubaoPacket(packet);
  const payload = JSON.parse(decoded.payload.toString("utf8"));

  assert.equal(decoded.messageType, 1);
  assert.equal(payload.app, undefined);
  assert.deepEqual(payload.user, { uid: "session-v3" });
  assert.deepEqual(payload.audio, {
    format: "pcm",
    sample_rate: 16000,
    bits: 16,
    channel: 1,
    codec: "raw",
  });
  assert.equal(payload.request.reqid, "session-v3");
  assert.equal(payload.request.model_name, "bigmodel");
  assert.equal(payload.request.show_utterances, true);
  assert.equal(payload.request.result_type, "single");
  assert.equal(payload.request.language, "zh");
  assert.equal(payload.request.enable_punc, true);
  assert.equal(payload.request.vad_signal, true);
  assert.equal(payload.request.start_silence_time, 700);
  assert.equal(payload.request.vad_silence_time, 900);
});

test("audio packets round-trip through binary codec", () => {
  const packet = createDoubaoAudioPacket(Buffer.from("pcm-bytes"), true);
  const decoded = decodeDoubaoPacket(packet);

  assert.equal(decoded.messageType, 2);
  assert.equal(decoded.flags, 2);
  assert.equal(decoded.payload.toString("utf8"), "pcm-bytes");
});

test("server responses map to partial final and completed realtime events", () => {
  const partialPacket = decodeDoubaoPacket(
    createDoubaoFullServerResponsePacket({
      code: 1000,
      sequence: 1,
      result: [{ text: "你好", utterances: [{ text: "你好，我想问", definite: false }] }],
    }),
  );
  const finalPacket = decodeDoubaoPacket(
    createDoubaoFullServerResponsePacket({
      code: 1000,
      sequence: -1,
      result: [{ text: "你好，我想问一下今天的天气。", utterances: [{ text: "你好，我想问一下今天的天气。", definite: true }] }],
    }),
  );

  assert.deepEqual(mapDoubaoResponseToRealtimeEvents(partialPacket), [
    { type: "partial", text: "你好，我想问" },
  ]);
  assert.deepEqual(mapDoubaoResponseToRealtimeEvents(finalPacket), [
    { type: "final", text: "你好，我想问一下今天的天气。" },
    { type: "completed", text: "你好，我想问一下今天的天气。" },
  ]);
});

test("bigmodel v3 object-shaped responses map to realtime events", () => {
  const partialPacket = decodeDoubaoPacket(
    createDoubaoFullServerResponsePacket(
      {
        code: 1000,
        result: {
          text: "312",
          utterances: [{ text: "312", definite: false }],
        },
      },
      { sequence: 15 },
    ),
  );
  const finalPacket = decodeDoubaoPacket(
    createDoubaoFullServerResponsePacket(
      {
        code: 1000,
        result: {
          text: "3123123123123。",
          utterances: [{ text: "3123123123123。", definite: true }],
        },
      },
      { sequence: 57 },
    ),
  );

  assert.deepEqual(mapDoubaoResponseToRealtimeEvents(partialPacket), [
    { type: "partial", text: "312" },
  ]);
  assert.deepEqual(mapDoubaoResponseToRealtimeEvents(finalPacket), [
    { type: "final", text: "3123123123123。" },
  ]);
});

test("server responses with sequence header map to realtime events", () => {
  const packet = decodeDoubaoPacket(
    createDoubaoFullServerResponsePacket(
      {
        code: 1000,
        result: [{ text: "你好，我想问一下今天的天气。", utterances: [{ text: "你好，我想问一下今天的天气。", definite: true }] }],
      },
      { sequence: -1 },
    ),
  );

  assert.equal(packet.sequence, -1);
  assert.deepEqual(mapDoubaoResponseToRealtimeEvents(packet), [
    { type: "final", text: "你好，我想问一下今天的天气。" },
    { type: "completed", text: "你好，我想问一下今天的天气。" },
  ]);
});

test("doubao realtime transport sends auth header and maps upstream websocket messages", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send(data) {
      this.sent.push(data);
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

  const factory = createDoubaoRealtimeTransportFactory(
    {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app-123",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoCluster: "streaming-asr",
      doubaoLanguage: "zh",
    },
    { WebSocket: FakeWebSocket },
  );

  const connection = await factory({
    sessionId: "session-2",
    language: "zh",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const instance = FakeWebSocket.instances[0];
  const events = [];
  connection.setEventHandler((event) => {
    events.push(event);
  });

  const appendPromise = connection.appendAudioChunk(Buffer.from("abc"));
  instance.emit("open");
  await appendPromise;
  await connection.commit();

  instance.emit("message", {
    data: createDoubaoFullServerResponsePacket({
      code: 1000,
      sequence: 1,
      result: [{ text: "你好", utterances: [{ text: "你好，我想问", definite: false }] }],
    }),
  });
  instance.emit("message", {
    data: createDoubaoFullServerResponsePacket({
      code: 1000,
      sequence: -1,
      result: [{ text: "你好，我想问一下。", utterances: [{ text: "你好，我想问一下。", definite: true }] }],
    }),
  });

  assert.equal(instance.url, "wss://example.invalid/asr");
  assert.deepEqual(instance.options, {
    headers: {
      Authorization: "Bearer; token-456",
    },
  });
  assert.equal(instance.binaryType, "arraybuffer");
  assert.equal(instance.sent.length, 3);
  assert.deepEqual(events, [
    { type: "partial", text: "你好，我想问" },
    { type: "final", text: "你好，我想问一下。" },
    { type: "completed", text: "你好，我想问一下。" },
  ]);
});

test("doubao realtime transport observer receives send receive close diagnostics", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send(data) {
      this.sent.push(data);
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

  const observed = [];
  const factory = createDoubaoRealtimeTransportFactory(
    {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "9630954272",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      doubaoResourceId: "volc.bigasr.sauc.duration",
    },
    {
      WebSocket: FakeWebSocket,
      observer: {
        onOpen(event) {
          observed.push({ type: "open", event });
        },
        onSend(event) {
          observed.push({ type: "send", event });
        },
        onReceive(event) {
          observed.push({
            type: "receive",
            event: {
              sequence: event.packet.sequence,
              payloadText: event.payloadText,
              mappedEvents: event.mappedEvents,
            },
          });
        },
        onClose(event) {
          observed.push({ type: "close", event });
        },
      },
    },
  );

  const connection = await factory({
    sessionId: "observer-session",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const instance = FakeWebSocket.instances[0];
  const appendPromise = connection.appendAudioChunk(Buffer.from("abc"));
  instance.emit("open");
  await appendPromise;
  await connection.commit();

  instance.emit("message", {
    data: createDoubaoFullServerResponsePacket(
      {
        code: 1000,
        result: [{ text: "你好", utterances: [{ text: "你好", definite: true }] }],
      },
      { sequence: -1 },
    ),
  });
  instance.emit("close", { code: 1000, reason: "finish last sequence" });

  assert.deepEqual(observed, [
    {
      type: "open",
      event: {
        sessionId: "observer-session",
        wsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
        protocolMode: "bigmodel-v3",
      },
    },
    {
      type: "send",
      event: {
        sessionId: "observer-session",
        kind: "full_request",
        protocolMode: "bigmodel-v3",
        packetBytes: instance.sent[0].length,
        sequence: 1,
      },
    },
    {
      type: "send",
      event: {
        sessionId: "observer-session",
        kind: "audio",
        protocolMode: "bigmodel-v3",
        packetBytes: instance.sent[1].length,
        audioBytes: 3,
        sequence: 2,
      },
    },
    {
      type: "send",
      event: {
        sessionId: "observer-session",
        kind: "commit",
        protocolMode: "bigmodel-v3",
        packetBytes: instance.sent[2].length,
        audioBytes: 0,
        sequence: -3,
      },
    },
    {
      type: "receive",
      event: {
        sequence: -1,
        payloadText: "{\"code\":1000,\"result\":[{\"text\":\"你好\",\"utterances\":[{\"text\":\"你好\",\"definite\":true}]}]}",
        mappedEvents: [
          { type: "final", text: "你好" },
          { type: "completed", text: "你好" },
        ],
      },
    },
    {
      type: "close",
      event: {
        sessionId: "observer-session",
        protocolMode: "bigmodel-v3",
        code: 1000,
        reason: "finish last sequence",
        terminalSeen: true,
      },
    },
  ]);
});

test("bigmodel v3 transport sends official x-api headers", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {}

    emit(type, event = {}) {
      for (const listener of this.listeners[type]) {
        listener(event);
      }
    }
  }

  const factory = createDoubaoRealtimeTransportFactory(
    {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "9630954272",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      doubaoResourceId: "volc.bigasr.sauc.duration",
    },
    { WebSocket: FakeWebSocket },
  );

  const connection = await factory({
    sessionId: "session-v3-auth",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const instance = FakeWebSocket.instances[0];
  const appendPromise = connection.appendAudioChunk(Buffer.from("abc"));
  instance.emit("open");
  await appendPromise;
  await connection.commit();

  assert.equal(instance.url, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel");
  assert.deepEqual(instance.options, {
    headers: {
      "X-Api-App-Key": "9630954272",
      "X-Api-Access-Key": "token-456",
      "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
      "X-Api-Connect-Id": "session-v3-auth",
      "X-Api-Request-Id": "session-v3-auth",
    },
  });
  assert.equal(instance.sent.length, 3);
});

test("bigmodel v3 close finish last sequence is treated as completed", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {}

    emit(type, event = {}) {
      for (const listener of this.listeners[type]) {
        listener(event);
      }
    }
  }

  const factory = createDoubaoRealtimeTransportFactory(
    {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "9630954272",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      doubaoResourceId: "volc.bigasr.sauc.duration",
    },
    { WebSocket: FakeWebSocket },
  );

  const connection = await factory({
    sessionId: "session-v3-close",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const events = [];
  connection.setEventHandler((event) => {
    events.push(event);
  });

  const instance = FakeWebSocket.instances[0];
  const appendPromise = connection.appendAudioChunk(Buffer.from("abc"));
  instance.emit("open");
  await appendPromise;
  await connection.commit();
  instance.emit("close", { code: 1000, reason: "finish last sequence" });

  assert.deepEqual(events, [{ type: "completed" }]);
});

test("doubao realtime transport does not leave an unhandled rejection when connect fails early", async () => {
  class FakeWebSocket {
    static instances = [];

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.binaryType = "blob";
      this.listeners = { open: [], message: [], error: [], close: [] };
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    send() {}

    close() {}

    emit(type, event = {}) {
      for (const listener of this.listeners[type]) {
        listener(event);
      }
    }
  }

  const factory = createDoubaoRealtimeTransportFactory(
    {
      transcriptionBackend: "doubao-realtime",
      doubaoAppId: "app-123",
      doubaoAccessToken: "token-456",
      doubaoWsUrl: "wss://example.invalid/asr",
      doubaoCluster: "streaming-asr",
    },
    { WebSocket: FakeWebSocket },
  );

  const connection = await factory({
    sessionId: "session-3",
    sampleRate: 16000,
    channels: 1,
    enablePartial: true,
  });

  const instance = FakeWebSocket.instances[0];
  let unhandledReason = null;
  const onUnhandledRejection = (reason) => {
    unhandledReason = reason;
  };
  process.once("unhandledRejection", onUnhandledRejection);

  try {
    instance.emit("error", { error: new Error("connect failed") });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      connection.appendAudioChunk(Buffer.from("abc")),
      /connect failed/,
    );
    assert.equal(unhandledReason, null);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("realtime session does not leave an unhandled rejection when upstream errors before commit", async () => {
  const transport = createTransportHarness();
  const session = new RealtimeSession(
    {
      audioFormat: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      enablePartial: true,
    },
    transport.factory,
    "session-early-error",
  );

  let unhandledReason = null;
  const onUnhandledRejection = (reason) => {
    unhandledReason = reason;
  };
  process.once("unhandledRejection", onUnhandledRejection);

  try {
    await session.start();
    transport.connections[0].emit({
      type: "error",
      code: "upstream_bootstrap_error",
      message: "failed before commit",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandledReason, null);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

function createDoubaoFullServerResponsePacket(payload, options = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const hasSequence = typeof options.sequence === "number";
  const header = Buffer.from([0x11, hasSequence ? 0x91 : 0x90, 0x11, 0x00]);
  const compressed = Buffer.from(gzipSync(body));
  if (!hasSequence) {
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(compressed.length, 0);
    return Buffer.concat([header, payloadSize, compressed]);
  }

  const sequence = Buffer.alloc(4);
  sequence.writeInt32BE(options.sequence, 0);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([header, sequence, payloadSize, compressed]);
}
