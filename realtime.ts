import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const REALTIME_ASR_PATH = "/plugins/macos-say-tts/asr/realtime";
const DEFAULT_REALTIME_CHUNK_MS = 100;
const DEFAULT_SESSION_TIMEOUT_SECONDS = 120;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 15;
const DEFAULT_MAX_AUDIO_SECONDS = 60;
const DOUBAO_SUCCESS_CODE = 1000;

const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE_UNITS = 0x1;
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_TYPE_SERVER_ERROR_RESPONSE = 0xf;
const MESSAGE_FLAG_NONE = 0x0;
const MESSAGE_FLAG_LAST_AUDIO = 0x2;
const SERIALIZATION_NONE = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_NONE = 0x0;
const COMPRESSION_GZIP = 0x1;

export type RealtimePluginConfig = {
  transcriptionBackend?: "local-whisper" | "openclaw-runtime" | "doubao-realtime";
  doubaoAppId?: string;
  doubaoAccessToken?: string;
  doubaoWsUrl?: string;
  doubaoResourceId?: string;
  doubaoCluster?: string;
  doubaoLanguage?: string;
  doubaoChunkMs?: number;
  doubaoEnableVad?: boolean;
  doubaoVadStartSilenceMs?: number;
  doubaoVadEndSilenceMs?: number;
  realtimeSessionTimeoutSeconds?: number;
  realtimeIdleTimeoutSeconds?: number;
  realtimeMaxAudioSeconds?: number;
};

export type RealtimeSessionStartParams = {
  audioFormat: "pcm_s16le";
  sampleRate: number;
  channels: number;
  language?: string;
  enablePartial?: boolean;
};

export type RealtimeTransportEvent =
  | { type: "partial"; text: string; utteranceId?: string }
  | { type: "final"; text: string; utteranceId?: string }
  | { type: "completed"; text?: string }
  | { type: "error"; code: string; message: string };

export type RealtimeSessionEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "transcript.partial"; text: string; utteranceId?: string }
  | { type: "transcript.final"; text: string; utteranceId?: string }
  | { type: "session.completed"; finalText: string }
  | { type: "error"; code: string; message: string };

export type RealtimeTransportConnection = {
  setEventHandler(handler: (event: RealtimeTransportEvent) => void): void;
  appendAudioChunk(chunk: Buffer): Promise<void>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
};

export type RealtimeTransportFactory = (params: {
  sessionId: string;
  language?: string;
  sampleRate: number;
  channels: number;
  enablePartial: boolean;
}) => Promise<RealtimeTransportConnection>;

type WebSocketLike = {
  readonly readyState?: number;
  binaryType?: string;
  send(data: string | Buffer | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown; error?: unknown; code?: number; reason?: string }) => void,
  ): void;
};

type WebSocketConstructor = new (
  url: string,
  options?: unknown,
) => WebSocketLike;

type DoubaoTransportDependencies = {
  WebSocket: WebSocketConstructor;
};

type DoubaoUtterance = {
  definite?: boolean;
  text?: string;
};

type DoubaoResponsePayload = {
  code?: number;
  message?: string;
  sequence?: number;
  result?: Array<{
    text?: string;
    utterances?: DoubaoUtterance[];
  }>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveDoubaoCluster(config: RealtimePluginConfig): string {
  return normalizeTrimmedString(config.doubaoCluster) || normalizeTrimmedString(config.doubaoResourceId);
}

function decodeAudioBase64(audioBase64: string): Buffer {
  const normalized = audioBase64.trim();
  if (!normalized) {
    throw new Error("Missing audio payload.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("Invalid base64 audio payload.");
  }
  return buffer;
}

export function isDoubaoRealtimeConfigured(config: RealtimePluginConfig): boolean {
  if ((config.transcriptionBackend ?? "local-whisper") !== "doubao-realtime") {
    return false;
  }
  return Boolean(
    normalizeTrimmedString(config.doubaoAppId) &&
      normalizeTrimmedString(config.doubaoAccessToken) &&
      normalizeTrimmedString(config.doubaoWsUrl) &&
      resolveDoubaoCluster(config),
  );
}

export function getRealtimeCapability(config: RealtimePluginConfig) {
  const backend = config.transcriptionBackend ?? "local-whisper";
  const chunkMs = normalizePositiveInt(config.doubaoChunkMs, DEFAULT_REALTIME_CHUNK_MS, 20, 1000);
  const sessionTimeoutSeconds = normalizePositiveInt(
    config.realtimeSessionTimeoutSeconds,
    DEFAULT_SESSION_TIMEOUT_SECONDS,
    10,
    600,
  );
  const idleTimeoutSeconds = normalizePositiveInt(
    config.realtimeIdleTimeoutSeconds,
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    5,
    120,
  );
  const maxAudioSeconds = normalizePositiveInt(
    config.realtimeMaxAudioSeconds,
    DEFAULT_MAX_AUDIO_SECONDS,
    5,
    300,
  );

  return {
    backend,
    enabled: backend === "doubao-realtime",
    configured: isDoubaoRealtimeConfigured(config),
    wsUrl: normalizeTrimmedString(config.doubaoWsUrl),
    cluster: resolveDoubaoCluster(config),
    language: normalizeTrimmedString(config.doubaoLanguage),
    chunkMs,
    enableVad: config.doubaoEnableVad !== false,
    vadStartSilenceMs: normalizePositiveInt(config.doubaoVadStartSilenceMs, 800, 100, 10000),
    vadEndSilenceMs: normalizePositiveInt(config.doubaoVadEndSilenceMs, 800, 100, 10000),
    sessionTimeoutSeconds,
    idleTimeoutSeconds,
    maxAudioSeconds,
  };
}

function encodeDoubaoPacket(params: {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
}): Buffer {
  const header = Buffer.alloc(8);
  header[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS;
  header[1] = (params.messageType << 4) | params.flags;
  header[2] = (params.serialization << 4) | params.compression;
  header[3] = 0x00;
  header.writeUInt32BE(params.payload.length, 4);
  return Buffer.concat([header, params.payload]);
}

function maybeCompress(payload: Buffer, compression: number): Buffer {
  if (compression === COMPRESSION_GZIP) {
    return gzipSync(payload);
  }
  return payload;
}

function maybeDecompress(payload: Buffer, compression: number): Buffer {
  if (compression === COMPRESSION_GZIP) {
    return gunzipSync(payload);
  }
  return payload;
}

export function createDoubaoFullRequestPacket(params: {
  config: RealtimePluginConfig;
  sessionId: string;
  language?: string;
  sampleRate: number;
  channels: number;
  enablePartial: boolean;
}): Buffer {
  const capability = getRealtimeCapability(params.config);
  const payload = Buffer.from(
    JSON.stringify({
      app: {
        appid: normalizeTrimmedString(params.config.doubaoAppId),
        token: normalizeTrimmedString(params.config.doubaoAccessToken),
        cluster: capability.cluster,
      },
      user: {
        uid: params.sessionId,
        device: "openclaw-plugin",
        platform: "node",
        network: "wired",
      },
      audio: {
        format: "raw",
        codec: "raw",
        rate: params.sampleRate,
        bits: 16,
        channel: params.channels,
      },
      request: {
        reqid: params.sessionId,
        sequence: 1,
        nbest: 1,
        workflow: "audio_in,resample,partition,vad,fe,decode,nlu_punctuate",
        show_utterances: params.enablePartial,
        result_type: params.enablePartial ? "single" : "full",
        language: params.language || capability.language || undefined,
        vad_signal: capability.enableVad,
        start_silence_time: capability.vadStartSilenceMs,
        vad_silence_time: capability.vadEndSilenceMs,
      },
    }),
    "utf8",
  );

  return encodeDoubaoPacket({
    messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: MESSAGE_FLAG_NONE,
    serialization: SERIALIZATION_JSON,
    compression: COMPRESSION_GZIP,
    payload: maybeCompress(payload, COMPRESSION_GZIP),
  });
}

export function createDoubaoAudioPacket(audioChunk: Buffer, isLast: boolean): Buffer {
  return encodeDoubaoPacket({
    messageType: MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    flags: isLast ? MESSAGE_FLAG_LAST_AUDIO : MESSAGE_FLAG_NONE,
    serialization: SERIALIZATION_NONE,
    compression: COMPRESSION_GZIP,
    payload: maybeCompress(audioChunk, COMPRESSION_GZIP),
  });
}

function normalizeIncomingBinaryMessage(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("Unsupported upstream realtime payload type.");
}

export function decodeDoubaoPacket(data: Buffer): {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
  errorCode?: number;
} {
  if (data.length < 8) {
    throw new Error("Invalid upstream realtime packet: too short.");
  }
  const version = data[0] >> 4;
  const headerSizeUnits = data[0] & 0x0f;
  if (version !== PROTOCOL_VERSION || headerSizeUnits !== HEADER_SIZE_UNITS) {
    throw new Error("Unsupported upstream realtime packet header.");
  }

  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;

  if (messageType === MESSAGE_TYPE_SERVER_ERROR_RESPONSE) {
    if (data.length < 12) {
      throw new Error("Invalid upstream error packet.");
    }
    const errorCode = data.readInt32BE(4);
    const payloadSize = data.readUInt32BE(8);
    const payload = maybeDecompress(data.subarray(12, 12 + payloadSize), compression);
    return {
      messageType,
      flags,
      serialization,
      compression,
      payload,
      errorCode,
    };
  }

  const payloadSize = data.readUInt32BE(4);
  const payload = maybeDecompress(data.subarray(8, 8 + payloadSize), compression);
  return {
    messageType,
    flags,
    serialization,
    compression,
    payload,
  };
}

export function mapDoubaoResponseToRealtimeEvents(packet: {
  messageType: number;
  payload: Buffer;
  serialization: number;
  errorCode?: number;
}): RealtimeTransportEvent[] {
  if (packet.messageType === MESSAGE_TYPE_SERVER_ERROR_RESPONSE) {
    return [
      {
        type: "error",
        code: `doubao_${packet.errorCode ?? "error"}`,
        message: packet.payload.toString("utf8") || "Doubao realtime ASR returned an error.",
      },
    ];
  }

  if (packet.messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE) {
    return [];
  }

  if (packet.serialization !== SERIALIZATION_JSON) {
    return [
      {
        type: "error",
        code: "doubao_invalid_serialization",
        message: "Doubao realtime ASR returned a non-JSON server response.",
      },
    ];
  }

  const payload = JSON.parse(packet.payload.toString("utf8")) as DoubaoResponsePayload;
  if ((payload.code ?? DOUBAO_SUCCESS_CODE) !== DOUBAO_SUCCESS_CODE) {
    return [
      {
        type: "error",
        code: `doubao_${payload.code ?? "error"}`,
        message: payload.message || "Doubao realtime ASR returned an error.",
      },
    ];
  }

  const result = payload.result?.[0];
  const utterance = result?.utterances?.[0];
  const events: RealtimeTransportEvent[] = [];

  if (utterance?.text) {
    if (utterance.definite) {
      events.push({ type: "final", text: utterance.text });
    } else {
      events.push({ type: "partial", text: utterance.text });
    }
  }

  if ((payload.sequence ?? 0) < 0) {
    events.push({
      type: "completed",
      text: normalizeTrimmedString(result?.text),
    });
  }

  return events;
}

class DoubaoRealtimeTransportConnection implements RealtimeTransportConnection {
  private readonly socket: WebSocketLike;
  private readonly openPromise: Promise<void>;
  private eventHandler: (event: RealtimeTransportEvent) => void = () => {};
  private closed = false;
  private terminalSeen = false;

  constructor(
    params: {
      wsUrl: string;
      accessToken: string;
      initialPacket: Buffer;
    },
    WebSocketImpl: WebSocketConstructor,
  ) {
    this.socket = new WebSocketImpl(params.wsUrl, {
      headers: {
        Authorization: `Bearer; ${params.accessToken}`,
      },
    });
    this.socket.binaryType = "arraybuffer";
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => {
        try {
          this.socket.send(params.initialPacket);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.socket.addEventListener("message", (event) => {
        try {
          const packet = decodeDoubaoPacket(normalizeIncomingBinaryMessage(event.data));
          for (const mappedEvent of mapDoubaoResponseToRealtimeEvents(packet)) {
            if (mappedEvent.type === "completed" || mappedEvent.type === "error") {
              this.terminalSeen = true;
            }
            this.eventHandler(mappedEvent);
          }
        } catch (error) {
          this.terminalSeen = true;
          this.eventHandler({
            type: "error",
            code: "doubao_decode_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      this.socket.addEventListener("error", (event) => {
        reject(event.error ?? new Error("Doubao realtime WebSocket failed to connect."));
      });
      this.socket.addEventListener("close", (event) => {
        if (!this.closed && !this.terminalSeen) {
          this.eventHandler({
            type: "error",
            code: `doubao_ws_close_${event.code ?? 0}`,
            message: String(event.reason || "Doubao realtime WebSocket closed."),
          });
        }
      });
    });
  }

  setEventHandler(handler: (event: RealtimeTransportEvent) => void): void {
    this.eventHandler = handler;
  }

  async appendAudioChunk(chunk: Buffer): Promise<void> {
    await this.openPromise;
    this.socket.send(createDoubaoAudioPacket(chunk, false));
  }

  async commit(): Promise<void> {
    await this.openPromise;
    this.socket.send(createDoubaoAudioPacket(Buffer.alloc(0), true));
  }

  async cancel(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.close(1000, "closing");
  }
}

function getDefaultWebSocketDependencies(): DoubaoTransportDependencies {
  const WebSocketImpl = globalThis.WebSocket as WebSocketConstructor | undefined;
  if (!WebSocketImpl) {
    throw new Error("Global WebSocket client is not available in this Node runtime.");
  }
  return {
    WebSocket: WebSocketImpl,
  };
}

export function createDoubaoRealtimeTransportFactory(
  config: RealtimePluginConfig,
  deps: DoubaoTransportDependencies = getDefaultWebSocketDependencies(),
): RealtimeTransportFactory {
  const capability = getRealtimeCapability(config);
  if (!capability.enabled) {
    throw new Error("Doubao realtime transport requested, but transcriptionBackend is not doubao-realtime.");
  }
  if (!capability.configured) {
    throw new Error("Doubao realtime transport requested, but required configuration is incomplete.");
  }

  const accessToken = normalizeTrimmedString(config.doubaoAccessToken);
  const wsUrl = capability.wsUrl;

  return async (params) => {
    const initialPacket = createDoubaoFullRequestPacket({
      config,
      sessionId: params.sessionId,
      language: params.language,
      sampleRate: params.sampleRate,
      channels: params.channels,
      enablePartial: params.enablePartial,
    });
    return new DoubaoRealtimeTransportConnection(
      {
        wsUrl,
        accessToken,
        initialPacket,
      },
      deps.WebSocket,
    );
  };
}

export class RealtimeSession {
  readonly id: string;

  private readonly params: RealtimeSessionStartParams;
  private readonly transportFactory: RealtimeTransportFactory;
  private readonly listeners = new Set<(event: RealtimeSessionEvent) => void>();
  private readonly completion = createDeferred<string>();
  private connection: RealtimeTransportConnection | null = null;
  private finalSegments: string[] = [];
  private partialText = "";
  private started = false;
  private closed = false;
  private touchedAt = Date.now();
  private totalAudioBytes = 0;

  constructor(
    params: RealtimeSessionStartParams,
    transportFactory: RealtimeTransportFactory,
    id: string = randomUUID(),
  ) {
    this.params = params;
    this.transportFactory = transportFactory;
    this.id = id;
  }

  onEvent(listener: (event: RealtimeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get lastTouchedAt(): number {
    return this.touchedAt;
  }

  get finalText(): string {
    return this.finalSegments.join("");
  }

  get bufferedPartialText(): string {
    return this.partialText;
  }

  get audioBytes(): number {
    return this.totalAudioBytes;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.connection = await this.transportFactory({
      sessionId: this.id,
      language: this.params.language,
      sampleRate: this.params.sampleRate,
      channels: this.params.channels,
      enablePartial: this.params.enablePartial !== false,
    });
    this.connection.setEventHandler((event) => {
      this.touch();
      this.handleUpstreamEvent(event);
    });
    this.started = true;
    this.emit({ type: "session.started", sessionId: this.id });
  }

  async appendAudioBase64(audioBase64: string): Promise<void> {
    this.ensureConnection();
    const chunk = decodeAudioBase64(audioBase64);
    this.totalAudioBytes += chunk.length;
    this.touch();
    await this.connection!.appendAudioChunk(chunk);
  }

  async commit(): Promise<string> {
    this.ensureConnection();
    this.touch();
    await this.connection!.commit();
    return await this.completion.promise;
  }

  async cancel(): Promise<void> {
    if (!this.connection) {
      this.closed = true;
      return;
    }
    this.touch();
    await this.connection.cancel();
    await this.close();
    this.completion.reject(new Error("Realtime session cancelled."));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.connection) {
      const connection = this.connection;
      this.connection = null;
      await connection.close();
    }
  }

  private touch(): void {
    this.touchedAt = Date.now();
  }

  private ensureConnection(): void {
    if (!this.connection) {
      throw new Error("Realtime session has not been started.");
    }
  }

  private handleUpstreamEvent(event: RealtimeTransportEvent): void {
    if (this.closed) {
      return;
    }

    if (event.type === "partial") {
      this.partialText = event.text;
      this.emit({
        type: "transcript.partial",
        text: event.text,
        utteranceId: event.utteranceId,
      });
      return;
    }

    if (event.type === "final") {
      this.partialText = "";
      if (event.text) {
        this.finalSegments.push(event.text);
      }
      this.emit({
        type: "transcript.final",
        text: event.text,
        utteranceId: event.utteranceId,
      });
      return;
    }

    if (event.type === "completed") {
      const finalText = typeof event.text === "string" && event.text.trim() ? event.text.trim() : this.finalText;
      this.emit({
        type: "session.completed",
        finalText,
      });
      this.completion.resolve(finalText);
      return;
    }

    this.emit({
      type: "error",
      code: event.code,
      message: event.message,
    });
    this.completion.reject(new Error(event.message));
  }

  private emit(event: RealtimeSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class RealtimeSessionManager {
  private readonly sessions = new Map<string, RealtimeSession>();
  private readonly capabilityInfo: ReturnType<typeof getRealtimeCapability>;
  private readonly transportFactory: RealtimeTransportFactory;

  constructor(
    config: RealtimePluginConfig,
    transportFactory: RealtimeTransportFactory,
  ) {
    this.capabilityInfo = getRealtimeCapability(config);
    this.transportFactory = transportFactory;
  }

  createSession(params: RealtimeSessionStartParams): RealtimeSession {
    const session = new RealtimeSession(params, this.transportFactory);
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): RealtimeSession | null {
    return this.sessions.get(id) ?? null;
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.delete(id);
    await session.close();
  }

  get size(): number {
    return this.sessions.size;
  }

  get capability() {
    return this.capabilityInfo;
  }

  async pruneExpiredSessions(now: number = Date.now()): Promise<string[]> {
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastTouchedAt < this.capabilityInfo.sessionTimeoutSeconds * 1000) {
        continue;
      }
      expiredIds.push(id);
      this.sessions.delete(id);
      await session.close();
    }
    return expiredIds;
  }
}
