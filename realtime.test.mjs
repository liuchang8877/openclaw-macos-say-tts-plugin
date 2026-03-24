import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
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

function createDoubaoFullServerResponsePacket(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header[0] = 0x11;
  header[1] = 0x90;
  header[2] = 0x11;
  header[3] = 0x00;
  const compressed = Buffer.from(gzipSync(body));
  header.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([header, compressed]);
}
