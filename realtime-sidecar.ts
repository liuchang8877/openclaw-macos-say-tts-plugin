import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REALTIME_ASR_PATH,
  createDoubaoRealtimeTransportFactory,
  type DoubaoRealtimeObserver,
  getRealtimeCapability,
  RealtimeSessionManager,
  type RealtimePluginConfig,
  type RealtimeSessionEvent,
} from "./realtime.ts";

type SidecarConfig = RealtimePluginConfig & {
  listenHost?: string;
  listenPort?: number;
  sidecarAuthToken?: string;
  pcmDumpDir?: string;
  inputGain?: number;
};

type RealtimeActionRequest = {
  type?: unknown;
  session_id?: unknown;
  audio_base64?: unknown;
  audio_format?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  language?: unknown;
  enable_partial?: unknown;
};

type DownstreamSessionStats = {
  packets: number;
  partials: number;
  finals: number;
  completions: number;
  lastCloseCode?: number;
  lastCloseReason?: string;
};

class RequestValidationError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "RequestValidationError";
    this.statusCode = statusCode;
  }
}

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolvePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = resolveNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function loadSidecarConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  return {
    transcriptionBackend: "doubao-realtime",
    doubaoAppId: env.DOUBAO_APP_ID,
    doubaoAccessToken: env.DOUBAO_ACCESS_TOKEN,
    doubaoWsUrl: env.DOUBAO_WS_URL,
    doubaoResourceId: env.DOUBAO_RESOURCE_ID,
    doubaoCluster: env.DOUBAO_CLUSTER,
    doubaoLanguage: env.DOUBAO_LANGUAGE,
    doubaoChunkMs: resolveNumber(env.DOUBAO_CHUNK_MS),
    doubaoEnableVad: resolveBooleanEnv(env.DOUBAO_ENABLE_VAD, true),
    doubaoVadStartSilenceMs: resolveNumber(env.DOUBAO_VAD_START_SILENCE_MS),
    doubaoVadEndSilenceMs: resolveNumber(env.DOUBAO_VAD_END_SILENCE_MS),
    realtimeSessionTimeoutSeconds: resolveNumber(env.REALTIME_SESSION_TIMEOUT_SECONDS),
    realtimeIdleTimeoutSeconds: resolveNumber(env.REALTIME_IDLE_TIMEOUT_SECONDS),
    realtimeMaxAudioSeconds: resolveNumber(env.REALTIME_MAX_AUDIO_SECONDS),
    listenHost: env.REALTIME_SIDECAR_HOST || "127.0.0.1",
    listenPort: resolveNumber(env.REALTIME_SIDECAR_PORT) ?? 8765,
    sidecarAuthToken: env.REALTIME_SIDECAR_AUTH_TOKEN,
    pcmDumpDir: normalizeTrimmedString(env.REALTIME_SIDECAR_PCM_DUMP_DIR) || undefined,
    inputGain: resolvePositiveNumber(env.REALTIME_SIDECAR_INPUT_GAIN, 1),
  };
}

function decodeAudioBase64(audioBase64: string): Buffer {
  const normalized = audioBase64.trim();
  if (!normalized) {
    throw new RequestValidationError(400, "Missing `audio_base64`.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new RequestValidationError(400, "Invalid `audio_base64`.");
  }
  return buffer;
}

function applyPcmS16LeGain(chunk: Buffer, gain: number): { chunk: Buffer; clippedSamples: number } {
  if (!Number.isFinite(gain) || gain <= 0 || Math.abs(gain - 1) < 1e-9) {
    return { chunk, clippedSamples: 0 };
  }

  const amplified = Buffer.allocUnsafe(chunk.length);
  let clippedSamples = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset);
    let scaled = Math.round(sample * gain);
    if (scaled > 32767) {
      scaled = 32767;
      clippedSamples += 1;
    } else if (scaled < -32768) {
      scaled = -32768;
      clippedSamples += 1;
    }
    amplified.writeInt16LE(scaled, offset);
  }
  return { chunk: amplified, clippedSamples };
}

function respondJson(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

async function readRequestBody(req: import("node:http").IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new RequestValidationError(413, "Request body too large.");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req, 8 * 1024 * 1024);
  if (!raw.length) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(400, "Invalid JSON body.");
  }
}

function resolveRealtimeActionType(value: unknown): "session.start" | "audio.append" | "session.commit" | "session.cancel" {
  if (typeof value !== "string") {
    throw new RequestValidationError(
      400,
      "Missing or invalid `type`. Use `session.start`, `audio.append`, `session.commit`, or `session.cancel`.",
    );
  }
  const normalized = value.trim();
  if (
    normalized === "session.start" ||
    normalized === "audio.append" ||
    normalized === "session.commit" ||
    normalized === "session.cancel"
  ) {
    return normalized;
  }
  throw new RequestValidationError(
    400,
    "Unsupported `type`. Use `session.start`, `audio.append`, `session.commit`, or `session.cancel`.",
  );
}

function resolveRealtimeSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestValidationError(400, "Missing `session_id`.");
  }
  return value.trim();
}

function resolveRealtimeLanguage(value: unknown): string | undefined {
  return normalizeTrimmedString(value) || undefined;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function resolveSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(400, "Missing or invalid `sample_rate`.");
  }
  const rounded = Math.round(value);
  if (rounded < 8000 || rounded > 48000) {
    throw new RequestValidationError(400, "`sample_rate` must be between 8000 and 48000.");
  }
  return rounded;
}

function resolveChannels(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  if (rounded !== 1) {
    throw new RequestValidationError(400, "Only mono audio (`channels=1`) is currently supported.");
  }
  return rounded;
}

function resolveRealtimeAudioFormat(value: unknown): "pcm_s16le" {
  if (value === undefined || value === null || value === "") {
    return "pcm_s16le";
  }
  if (typeof value !== "string" || value.trim() !== "pcm_s16le") {
    throw new RequestValidationError(400, "Unsupported `audio_format`. Use `pcm_s16le`.");
  }
  return "pcm_s16le";
}

function isAuthorized(req: import("node:http").IncomingMessage, authToken: string): boolean {
  if (!authToken) {
    return true;
  }
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  return header.trim() === `Bearer ${authToken}`;
}

function summarizeText(value: string | undefined, maxLength: number = 160): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function startSidecar(config: SidecarConfig): Promise<void> {
  const capability = getRealtimeCapability(config);
  if (!capability.configured) {
    throw new Error("Realtime sidecar config is incomplete. Check DOUBAO_APP_ID, DOUBAO_ACCESS_TOKEN, DOUBAO_WS_URL and DOUBAO_CLUSTER.");
  }

  const downstreamStats = new Map<string, DownstreamSessionStats>();
  const transportObserver: DoubaoRealtimeObserver = {
    onOpen(event) {
      console.info(
        `[realtime-sidecar] doubao.open ${event.sessionId} protocol=${event.protocolMode} ws=${event.wsUrl}`,
      );
    },
    onSend(event) {
      if (event.kind === "audio") {
        return;
      }
      console.info(
        `[realtime-sidecar] doubao.send ${event.sessionId} kind=${event.kind} protocol=${event.protocolMode} ` +
          `packetBytes=${event.packetBytes}` +
          (typeof event.audioBytes === "number" ? ` audioBytes=${event.audioBytes}` : "") +
          (typeof event.sequence === "number" ? ` sequence=${event.sequence}` : ""),
      );
    },
    onReceive(event) {
      const stats = downstreamStats.get(event.sessionId) ?? {
        packets: 0,
        partials: 0,
        finals: 0,
        completions: 0,
      };
      stats.packets += 1;
      for (const mappedEvent of event.mappedEvents) {
        if (mappedEvent.type === "partial") {
          stats.partials += 1;
        } else if (mappedEvent.type === "final") {
          stats.finals += 1;
        } else if (mappedEvent.type === "completed") {
          stats.completions += 1;
        }
      }
      downstreamStats.set(event.sessionId, stats);

      const result = Array.isArray(event.response?.result)
        ? event.response?.result[0]
        : event.response?.result;
      const utterance = result?.utterances?.[0];
      const mapped = event.mappedEvents
        .map((mappedEvent) => {
          if (mappedEvent.type === "partial" || mappedEvent.type === "final") {
            return `${mappedEvent.type}:${summarizeText(mappedEvent.text, 60) || "<empty>"}`;
          }
          if (mappedEvent.type === "completed") {
            return `completed:${summarizeText(mappedEvent.text, 60) || "<empty>"}`;
          }
          return `error:${mappedEvent.code}`;
        })
        .join("|");

      console.info(
        `[realtime-sidecar] doubao.recv ${event.sessionId} protocol=${event.protocolMode} ` +
          `packetType=${event.packet.messageType} flags=${event.packet.flags} ` +
          `serialization=${event.packet.serialization} compression=${event.packet.compression} ` +
          `packetSeq=${event.packet.sequence ?? "none"} responseSeq=${event.response?.sequence ?? "none"} ` +
          `code=${event.response?.code ?? event.packet.errorCode ?? 1000} ` +
          `payloadBytes=${event.packet.payload.length} ` +
          `utteranceDefinite=${utterance?.definite === true ? "true" : utterance?.definite === false ? "false" : "none"} ` +
          `utteranceText="${summarizeText(utterance?.text)}" resultText="${summarizeText(result?.text)}" ` +
          `mapped=${mapped || "none"} payload="${summarizeText(event.payloadText, 320)}"`,
      );
    },
    onClose(event) {
      const stats = downstreamStats.get(event.sessionId) ?? {
        packets: 0,
        partials: 0,
        finals: 0,
        completions: 0,
      };
      stats.lastCloseCode = event.code;
      stats.lastCloseReason = event.reason;
      downstreamStats.set(event.sessionId, stats);
      console.info(
        `[realtime-sidecar] doubao.close ${event.sessionId} protocol=${event.protocolMode} ` +
          `code=${event.code} reason="${summarizeText(event.reason, 120)}" terminalSeen=${event.terminalSeen}`,
      );
    },
    onError(event) {
      console.error(
        `[realtime-sidecar] doubao.error ${event.sessionId} protocol=${event.protocolMode} ` +
          `stage=${event.stage} message="${summarizeText(event.message, 240)}"`,
      );
    },
  };

  const manager = new RealtimeSessionManager(
    config,
    createDoubaoRealtimeTransportFactory(config, {
      WebSocket: globalThis.WebSocket as typeof WebSocket,
      observer: transportObserver,
    }),
  );
  const events = new Map<string, RealtimeSessionEvent[]>();
  const pcmDumpPaths = new Map<string, string>();

  function drainRealtimeEvents(sessionId: string): RealtimeSessionEvent[] {
    const value = events.get(sessionId) ?? [];
    events.set(sessionId, []);
    return value;
  }

  function pushRealtimeEvent(sessionId: string, event: RealtimeSessionEvent): void {
    const value = events.get(sessionId) ?? [];
    value.push(event);
    events.set(sessionId, value);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        respondJson(res, 200, {
          ok: true,
          service: "macos-say-tts-realtime-sidecar",
          realtimePath: REALTIME_ASR_PATH,
          sessions: manager.size,
          backend: capability.backend,
          configured: capability.configured,
          input_gain: config.inputGain ?? 1,
        });
        return;
      }

      if (req.method !== "POST" || url.pathname !== REALTIME_ASR_PATH) {
        respondJson(res, 404, { error: { message: "Not found." } });
        return;
      }

      if (!isAuthorized(req, normalizeTrimmedString(config.sidecarAuthToken))) {
        respondJson(res, 401, { error: { message: "Unauthorized." } });
        return;
      }

      await manager.pruneExpiredSessions();
      const body = await readJsonBody(req) as RealtimeActionRequest;
      const action = resolveRealtimeActionType(body.type);

      if (action === "session.start") {
        const session = manager.createSession({
          audioFormat: resolveRealtimeAudioFormat(body.audio_format),
          sampleRate: resolveSampleRate(body.sample_rate),
          channels: resolveChannels(body.channels),
          language: resolveRealtimeLanguage(body.language),
          enablePartial: resolveBoolean(body.enable_partial, true),
        });
        const startedAt = Date.now();
        events.set(session.id, []);
        downstreamStats.set(session.id, {
          packets: 0,
          partials: 0,
          finals: 0,
          completions: 0,
        });
        if (config.pcmDumpDir) {
          const dumpPath = join(config.pcmDumpDir, `openclaw-realtime-${session.id}.pcm`);
          await mkdir(config.pcmDumpDir, { recursive: true });
          await writeFile(dumpPath, "");
          pcmDumpPaths.set(session.id, dumpPath);
        }
        session.onEvent((event) => {
          if (event.type === "transcript.partial") {
            const current = events.get(session.id) ?? [];
            if (!current.some((item) => item.type === "transcript.partial")) {
              console.info(`[realtime-sidecar] first partial ${session.id} after ${Date.now() - startedAt}ms`);
            }
          }
          if (event.type === "transcript.final") {
            console.info(`[realtime-sidecar] final ${session.id} chars=${event.text.length}`);
          }
          pushRealtimeEvent(session.id, event);
        });
        await session.start();
        console.info(
          `[realtime-sidecar] session started ${session.id}` +
            ` inputGain=${config.inputGain ?? 1}` +
            (pcmDumpPaths.has(session.id) ? ` pcmDump=${pcmDumpPaths.get(session.id)}` : ""),
        );
        respondJson(res, 200, {
          session_id: session.id,
          events: drainRealtimeEvents(session.id),
          chunk_ms: capability.chunkMs,
        });
        return;
      }

      const sessionId = resolveRealtimeSessionId(body.session_id);
      const session = manager.getSession(sessionId);
      if (!session) {
        respondJson(res, 404, {
          error: {
            message: "Realtime session not found.",
          },
        });
        return;
      }

      if (action === "audio.append") {
        if (typeof body.audio_base64 !== "string" || !body.audio_base64.trim()) {
          throw new RequestValidationError(400, "Missing `audio_base64`.");
        }
        const rawChunk = decodeAudioBase64(body.audio_base64);
        const { chunk, clippedSamples } = applyPcmS16LeGain(rawChunk, config.inputGain ?? 1);
        const pcmDumpPath = pcmDumpPaths.get(session.id);
        if (pcmDumpPath) {
          try {
            await appendFile(pcmDumpPath, chunk);
          } catch (error) {
            console.error(`[realtime-sidecar] pcm dump append failed ${session.id} path=${pcmDumpPath}`, error);
          }
        }
        await session.appendAudioChunk(chunk);
        console.info(
          `[realtime-sidecar] audio.append ${session.id} ` +
            `chunkBytes=${chunk.length} audioBytes=${session.audioBytes} chunks=${session.audioChunks} ` +
            `inputGain=${config.inputGain ?? 1} clippedSamples=${clippedSamples}` +
            (pcmDumpPath ? ` pcmDump=${pcmDumpPath}` : ""),
        );
        respondJson(res, 200, {
          session_id: session.id,
          events: drainRealtimeEvents(session.id),
        });
        return;
      }

      if (action === "session.commit") {
        try {
          const commitStartedAt = Date.now();
          const finalText = await session.commit();
          const resultEvents = drainRealtimeEvents(session.id);
          const pcmDumpPath = pcmDumpPaths.get(session.id);
          const stats = downstreamStats.get(session.id);
          await manager.closeSession(session.id);
          events.delete(session.id);
          pcmDumpPaths.delete(session.id);
          downstreamStats.delete(session.id);
          console.info(
            `[realtime-sidecar] session committed ${session.id} in ${Date.now() - commitStartedAt}ms ` +
              `audioBytes=${session.audioBytes} chunks=${session.audioChunks} finalChars=${finalText.length}` +
              ` downstreamPackets=${stats?.packets ?? 0} partials=${stats?.partials ?? 0}` +
              ` finals=${stats?.finals ?? 0} completions=${stats?.completions ?? 0}` +
              (typeof stats?.lastCloseCode === "number" ? ` closeCode=${stats.lastCloseCode}` : "") +
              (stats?.lastCloseReason ? ` closeReason="${summarizeText(stats.lastCloseReason, 120)}"` : "") +
              (pcmDumpPath ? ` pcmDump=${pcmDumpPath}` : ""),
          );
          respondJson(res, 200, {
            session_id: session.id,
            final_text: finalText,
            events: resultEvents,
          });
          return;
        } catch (error) {
          const resultEvents = drainRealtimeEvents(session.id);
          const pcmDumpPath = pcmDumpPaths.get(session.id);
          const stats = downstreamStats.get(session.id);
          await manager.closeSession(session.id);
          events.delete(session.id);
          pcmDumpPaths.delete(session.id);
          downstreamStats.delete(session.id);
          console.error(
            `[realtime-sidecar] session commit failed ${session.id} ` +
              `audioBytes=${session.audioBytes} chunks=${session.audioChunks}` +
              ` downstreamPackets=${stats?.packets ?? 0} partials=${stats?.partials ?? 0}` +
              ` finals=${stats?.finals ?? 0} completions=${stats?.completions ?? 0}` +
              (typeof stats?.lastCloseCode === "number" ? ` closeCode=${stats.lastCloseCode}` : "") +
              (stats?.lastCloseReason ? ` closeReason="${summarizeText(stats.lastCloseReason, 120)}"` : "") +
              (pcmDumpPath ? ` pcmDump=${pcmDumpPath}` : ""),
            error,
          );
          respondJson(res, 502, {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
            session_id: session.id,
            events: resultEvents,
          });
          return;
        }
      }

      await session.cancel();
      const resultEvents = drainRealtimeEvents(session.id);
      const stats = downstreamStats.get(session.id);
      await manager.closeSession(session.id);
      events.delete(session.id);
      pcmDumpPaths.delete(session.id);
      downstreamStats.delete(session.id);
      console.info(
        `[realtime-sidecar] session cancelled ${session.id} downstreamPackets=${stats?.packets ?? 0}`,
      );
      respondJson(res, 200, {
        session_id: session.id,
        events: resultEvents,
        cancelled: true,
      });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        respondJson(res, error.statusCode, { error: { message: error.message } });
        return;
      }
      console.error("[realtime-sidecar] request failed", error);
      respondJson(res, 500, { error: { message: "Realtime STT request failed." } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.info(
    `[realtime-sidecar] listening on http://${config.listenHost}:${config.listenPort}${REALTIME_ASR_PATH}`,
  );
}

const config = loadSidecarConfig();
startSidecar(config).catch((error) => {
  console.error("[realtime-sidecar] failed to start", error);
  process.exitCode = 1;
});
