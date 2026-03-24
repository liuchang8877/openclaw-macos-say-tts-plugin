import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const REALTIME_ASR_PATH = "/plugins/macos-say-tts/asr/realtime";
const DEFAULT_REALTIME_CHUNK_MS = 100;
const DEFAULT_SESSION_TIMEOUT_SECONDS = 120;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 15;
const DEFAULT_MAX_AUDIO_SECONDS = 60;
const DOUBAO_SUCCESS_CODE = 1000;
const DOUBAO_BIGMODEL_WS_PATH = "/api/v3/sauc/bigmodel";
const DOUBAO_BIGMODEL_MODEL_NAME = "bigmodel";

const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE_UNITS = 0x1;
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_TYPE_SERVER_ERROR_RESPONSE = 0xf;
const MESSAGE_FLAG_NONE = 0x0;
const MESSAGE_FLAG_HAS_SEQUENCE = 0x1;
const MESSAGE_FLAG_POS_SEQUENCE = 0x1;
const MESSAGE_FLAG_LAST_AUDIO = 0x2;
const MESSAGE_FLAG_NEG_SEQUENCE = 0x3;
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

type DecodedDoubaoPacket = {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
  errorCode?: number;
  sequence?: number;
};

export type DoubaoRealtimeObserver = {
  onOpen?: (event: {
    sessionId: string;
    wsUrl: string;
    protocolMode: DoubaoProtocolMode;
  }) => void;
  onSend?: (event: {
    sessionId: string;
    kind: "full_request" | "audio" | "commit";
    protocolMode: DoubaoProtocolMode;
    packetBytes: number;
    audioBytes?: number;
    sequence?: number;
  }) => void;
  onReceive?: (event: {
    sessionId: string;
    protocolMode: DoubaoProtocolMode;
    packet: DecodedDoubaoPacket;
    payloadText: string;
    response: DoubaoResponsePayload | null;
    mappedEvents: RealtimeTransportEvent[];
  }) => void;
  onClose?: (event: {
    sessionId: string;
    protocolMode: DoubaoProtocolMode;
    code: number;
    reason: string;
    terminalSeen: boolean;
  }) => void;
  onError?: (event: {
    sessionId: string;
    protocolMode: DoubaoProtocolMode;
    stage: "connect" | "decode";
    message: string;
  }) => void;
};

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
  observer?: DoubaoRealtimeObserver;
};

type DoubaoProtocolMode = "classic-v2" | "bigmodel-v3";

type DoubaoWebSocketHeaders = Record<string, string>;

type DoubaoUtterance = {
  definite?: boolean;
  text?: string;
};

type DoubaoResponseResult = {
  text?: string;
  utterances?: DoubaoUtterance[];
};

type DoubaoResponsePayload = {
  code?: number;
  message?: string;
  sequence?: number;
  result?: DoubaoResponseResult | DoubaoResponseResult[];
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

function isDoubaoBigmodelWsUrl(value: string): boolean {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).pathname === DOUBAO_BIGMODEL_WS_PATH;
  } catch {
    return value.includes(DOUBAO_BIGMODEL_WS_PATH);
  }
}

function resolveDoubaoProtocolMode(config: RealtimePluginConfig): DoubaoProtocolMode {
  return isDoubaoBigmodelWsUrl(normalizeTrimmedString(config.doubaoWsUrl)) ? "bigmodel-v3" : "classic-v2";
}

function resolveDoubaoResourceId(config: RealtimePluginConfig): string {
  return normalizeTrimmedString(config.doubaoResourceId);
}

function resolveDoubaoCluster(config: RealtimePluginConfig): string {
  return normalizeTrimmedString(config.doubaoCluster) || resolveDoubaoResourceId(config);
}

function createDoubaoWebSocketHeaders(
  config: RealtimePluginConfig,
  sessionId: string,
): DoubaoWebSocketHeaders {
  const appId = normalizeTrimmedString(config.doubaoAppId);
  const accessToken = normalizeTrimmedString(config.doubaoAccessToken);
  if (resolveDoubaoProtocolMode(config) === "bigmodel-v3") {
    return {
      "X-Api-App-Key": appId,
      "X-Api-Access-Key": accessToken,
      "X-Api-Resource-Id": resolveDoubaoResourceId(config),
      "X-Api-Connect-Id": sessionId,
      "X-Api-Request-Id": sessionId,
    };
  }
  return {
    Authorization: `Bearer; ${accessToken}`,
  };
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
  const mode = resolveDoubaoProtocolMode(config);
  return Boolean(
    normalizeTrimmedString(config.doubaoAppId) &&
      normalizeTrimmedString(config.doubaoAccessToken) &&
      normalizeTrimmedString(config.doubaoWsUrl) &&
      (mode === "bigmodel-v3" ? resolveDoubaoResourceId(config) : resolveDoubaoCluster(config)),
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
  sequence?: number;
}): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS;
  header[1] = (params.messageType << 4) | params.flags;
  header[2] = (params.serialization << 4) | params.compression;
  header[3] = 0x00;
  const chunks = [header];
  if (typeof params.sequence === "number") {
    const sequence = Buffer.alloc(4);
    sequence.writeInt32BE(params.sequence, 0);
    chunks.push(sequence);
  }
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(params.payload.length, 0);
  chunks.push(payloadSize, params.payload);
  return Buffer.concat(chunks);
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
  const mode = resolveDoubaoProtocolMode(params.config);
  const payloadBody =
    mode === "bigmodel-v3"
      ? {
          user: {
            uid: params.sessionId,
          },
          audio: {
            format: "pcm",
            sample_rate: params.sampleRate,
            bits: 16,
            channel: params.channels,
            codec: "raw",
          },
          request: {
            reqid: params.sessionId,
            model_name: DOUBAO_BIGMODEL_MODEL_NAME,
            show_utterances: params.enablePartial,
            result_type: params.enablePartial ? "single" : "full",
            language: params.language || capability.language || undefined,
            enable_punc: true,
            vad_signal: capability.enableVad,
            start_silence_time: capability.vadStartSilenceMs,
            vad_silence_time: capability.vadEndSilenceMs,
          },
        }
      : {
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
        };
  const payload = Buffer.from(JSON.stringify(payloadBody), "utf8");

  return encodeDoubaoPacket({
    messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: mode === "bigmodel-v3" ? MESSAGE_FLAG_POS_SEQUENCE : MESSAGE_FLAG_NONE,
    serialization: SERIALIZATION_JSON,
    compression: COMPRESSION_GZIP,
    payload: maybeCompress(payload, COMPRESSION_GZIP),
    sequence: mode === "bigmodel-v3" ? 1 : undefined,
  });
}

export function createDoubaoAudioPacket(
  audioChunk: Buffer,
  isLast: boolean,
  options: {
    protocolMode?: DoubaoProtocolMode;
    sequence?: number;
  } = {},
): Buffer {
  const protocolMode = options.protocolMode ?? "classic-v2";
  const isBigmodelV3 = protocolMode === "bigmodel-v3";
  const compression = COMPRESSION_GZIP;
  const payload = maybeCompress(audioChunk, compression);
  return encodeDoubaoPacket({
    messageType: MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    flags: isBigmodelV3
      ? isLast
        ? MESSAGE_FLAG_NEG_SEQUENCE
        : MESSAGE_FLAG_POS_SEQUENCE
      : isLast
        ? MESSAGE_FLAG_LAST_AUDIO
        : MESSAGE_FLAG_NONE,
    serialization: SERIALIZATION_NONE,
    compression,
    payload,
    sequence: isBigmodelV3 ? options.sequence : undefined,
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

export function decodeDoubaoPacket(data: Buffer): DecodedDoubaoPacket {
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
  const hasSequence = (flags & MESSAGE_FLAG_HAS_SEQUENCE) === MESSAGE_FLAG_HAS_SEQUENCE;

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

  const sequence = hasSequence ? data.readInt32BE(4) : undefined;
  const payloadSizeOffset = hasSequence ? 8 : 4;
  const payloadOffset = hasSequence ? 12 : 8;
  const payloadSize = data.readUInt32BE(payloadSizeOffset);
  const payload = maybeDecompress(data.subarray(payloadOffset, payloadOffset + payloadSize), compression);
  return {
    messageType,
    flags,
    serialization,
    compression,
    payload,
    sequence,
  };
}

function tryParseDoubaoResponsePayload(packet: DecodedDoubaoPacket): DoubaoResponsePayload | null {
  if (packet.messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE && packet.messageType !== MESSAGE_TYPE_SERVER_ERROR_RESPONSE) {
    return null;
  }
  if (packet.serialization !== SERIALIZATION_JSON) {
    return null;
  }
  try {
    return JSON.parse(packet.payload.toString("utf8")) as DoubaoResponsePayload;
  } catch {
    return null;
  }
}

function resolveDoubaoResult(payload: DoubaoResponsePayload): DoubaoResponseResult | undefined {
  if (Array.isArray(payload.result)) {
    return payload.result[0];
  }
  if (payload.result && typeof payload.result === "object") {
    return payload.result;
  }
  return undefined;
}

export function mapDoubaoResponseToRealtimeEvents(packet: {
  messageType: number;
  payload: Buffer;
  serialization: number;
  errorCode?: number;
  sequence?: number;
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

  const result = resolveDoubaoResult(payload);
  const utterance = result?.utterances?.[0];
  const events: RealtimeTransportEvent[] = [];
  const sequence = typeof payload.sequence === "number" ? payload.sequence : packet.sequence ?? 0;

  if (utterance?.text) {
    if (utterance.definite) {
      events.push({ type: "final", text: utterance.text });
    } else {
      events.push({ type: "partial", text: utterance.text });
    }
  }

  if (sequence < 0) {
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
  private readonly protocolMode: DoubaoProtocolMode;
  private readonly sessionId: string;
  private readonly observer?: DoubaoRealtimeObserver;
  private eventHandler: (event: RealtimeTransportEvent) => void = () => {};
  private closed = false;
  private terminalSeen = false;
  private nextAudioSequence = 2;

  constructor(
    params: {
      sessionId: string;
      wsUrl: string;
      headers: DoubaoWebSocketHeaders;
      initialPacket: Buffer;
      protocolMode: DoubaoProtocolMode;
      observer?: DoubaoRealtimeObserver;
    },
    WebSocketImpl: WebSocketConstructor,
  ) {
    this.sessionId = params.sessionId;
    this.protocolMode = params.protocolMode;
    this.observer = params.observer;
    this.socket = new WebSocketImpl(params.wsUrl, {
      headers: params.headers,
    });
    this.socket.binaryType = "arraybuffer";
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => {
        try {
          this.observer?.onOpen?.({
            sessionId: params.sessionId,
            wsUrl: params.wsUrl,
            protocolMode: params.protocolMode,
          });
          this.observer?.onSend?.({
            sessionId: params.sessionId,
            kind: "full_request",
            protocolMode: params.protocolMode,
            packetBytes: params.initialPacket.length,
            sequence: params.protocolMode === "bigmodel-v3" ? 1 : undefined,
          });
          this.socket.send(params.initialPacket);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.socket.addEventListener("message", (event) => {
        try {
          const packet = decodeDoubaoPacket(normalizeIncomingBinaryMessage(event.data));
          const mappedEvents = mapDoubaoResponseToRealtimeEvents(packet);
          this.observer?.onReceive?.({
            sessionId: params.sessionId,
            protocolMode: params.protocolMode,
            packet,
            payloadText: packet.payload.toString("utf8"),
            response: tryParseDoubaoResponsePayload(packet),
            mappedEvents,
          });
          for (const mappedEvent of mappedEvents) {
            if (mappedEvent.type === "completed" || mappedEvent.type === "error") {
              this.terminalSeen = true;
            }
            this.eventHandler(mappedEvent);
          }
        } catch (error) {
          this.terminalSeen = true;
          this.observer?.onError?.({
            sessionId: params.sessionId,
            protocolMode: params.protocolMode,
            stage: "decode",
            message: error instanceof Error ? error.message : String(error),
          });
          this.eventHandler({
            type: "error",
            code: "doubao_decode_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      this.socket.addEventListener("error", (event) => {
        this.observer?.onError?.({
          sessionId: params.sessionId,
          protocolMode: params.protocolMode,
          stage: "connect",
          message: event.error instanceof Error ? event.error.message : String(event.error ?? "Doubao realtime WebSocket failed to connect."),
        });
        reject(event.error ?? new Error("Doubao realtime WebSocket failed to connect."));
      });
      this.socket.addEventListener("close", (event) => {
        this.observer?.onClose?.({
          sessionId: params.sessionId,
          protocolMode: params.protocolMode,
          code: event.code ?? 0,
          reason: String(event.reason || ""),
          terminalSeen: this.terminalSeen,
        });
        if (!this.closed && !this.terminalSeen) {
          if (
            this.protocolMode === "bigmodel-v3" &&
            (event.code ?? 0) === 1000 &&
            String(event.reason || "").includes("finish last sequence")
          ) {
            this.terminalSeen = true;
            this.eventHandler({
              type: "completed",
            });
            return;
          }
          this.eventHandler({
            type: "error",
            code: `doubao_ws_close_${event.code ?? 0}`,
            message: String(event.reason || "Doubao realtime WebSocket closed."),
          });
        }
      });
    });
    // The actual websocket handshake happens after session.start returns.
    // Consume connection failures here so a failed upstream dial does not
    // become an unhandled rejection and crash the whole sidecar process.
    this.openPromise.catch(() => {});
  }

  setEventHandler(handler: (event: RealtimeTransportEvent) => void): void {
    this.eventHandler = handler;
  }

  async appendAudioChunk(chunk: Buffer): Promise<void> {
    await this.openPromise;
    const sequence = this.protocolMode === "bigmodel-v3" ? this.nextAudioSequence++ : undefined;
    const packet = createDoubaoAudioPacket(chunk, false, {
      protocolMode: this.protocolMode,
      sequence,
    });
    this.socket.send(packet);
    this.observer?.onSend?.({
      sessionId: this.sessionId,
      kind: "audio",
      protocolMode: this.protocolMode,
      packetBytes: packet.length,
      audioBytes: chunk.length,
      sequence,
    });
  }

  async commit(): Promise<void> {
    await this.openPromise;
    const sequence = this.protocolMode === "bigmodel-v3" ? -this.nextAudioSequence++ : undefined;
    const packet = createDoubaoAudioPacket(Buffer.alloc(0), true, {
      protocolMode: this.protocolMode,
      sequence,
    });
    this.socket.send(packet);
    this.observer?.onSend?.({
      sessionId: this.sessionId,
      kind: "commit",
      protocolMode: this.protocolMode,
      packetBytes: packet.length,
      audioBytes: 0,
      sequence,
    });
  }

  async cancel(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.close(1000, "closing");
    } catch {
      // Undici can throw if close() happens before the connection is established.
      // At this point the caller is already tearing the transport down anyway.
    }
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

  const wsUrl = capability.wsUrl;
  const protocolMode = resolveDoubaoProtocolMode(config);

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
        headers: createDoubaoWebSocketHeaders(config, params.sessionId),
        initialPacket,
        protocolMode,
        sessionId: params.sessionId,
        observer: deps.observer,
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
  private totalAudioChunks = 0;

  constructor(
    params: RealtimeSessionStartParams,
    transportFactory: RealtimeTransportFactory,
    id: string = randomUUID(),
  ) {
    this.params = params;
    this.transportFactory = transportFactory;
    this.id = id;
    // Upstream failures can arrive before the caller awaits commit().
    // Consume the deferred rejection here so it never becomes an
    // unhandled rejection that terminates the sidecar process.
    this.completion.promise.catch(() => {});
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

  get audioChunks(): number {
    return this.totalAudioChunks;
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
    const chunk = decodeAudioBase64(audioBase64);
    await this.appendAudioChunk(chunk);
  }

  async appendAudioChunk(chunk: Buffer): Promise<void> {
    this.ensureConnection();
    this.totalAudioBytes += chunk.length;
    this.totalAudioChunks += 1;
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
