import { createServer } from "node:http";
import {
  REALTIME_ASR_PATH,
  createDoubaoRealtimeTransportFactory,
  getRealtimeCapability,
  RealtimeSessionManager,
  type RealtimePluginConfig,
  type RealtimeSessionEvent,
} from "./realtime.ts";

type SidecarConfig = RealtimePluginConfig & {
  listenHost?: string;
  listenPort?: number;
  sidecarAuthToken?: string;
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
  };
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

async function startSidecar(config: SidecarConfig): Promise<void> {
  const capability = getRealtimeCapability(config);
  if (!capability.configured) {
    throw new Error("Realtime sidecar config is incomplete. Check DOUBAO_APP_ID, DOUBAO_ACCESS_TOKEN, DOUBAO_WS_URL and DOUBAO_CLUSTER.");
  }

  const manager = new RealtimeSessionManager(config, createDoubaoRealtimeTransportFactory(config));
  const events = new Map<string, RealtimeSessionEvent[]>();

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
        session.onEvent((event) => {
          if (event.type === "transcript.partial") {
            const current = events.get(session.id) ?? [];
            if (!current.some((item) => item.type === "transcript.partial")) {
              console.info(`[realtime-sidecar] first partial ${session.id} after ${Date.now() - startedAt}ms`);
            }
          }
          pushRealtimeEvent(session.id, event);
        });
        await session.start();
        console.info(`[realtime-sidecar] session started ${session.id}`);
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
        await session.appendAudioBase64(body.audio_base64);
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
          await manager.closeSession(session.id);
          events.delete(session.id);
          console.info(`[realtime-sidecar] session committed ${session.id} in ${Date.now() - commitStartedAt}ms finalChars=${finalText.length}`);
          respondJson(res, 200, {
            session_id: session.id,
            final_text: finalText,
            events: resultEvents,
          });
          return;
        } catch (error) {
          const resultEvents = drainRealtimeEvents(session.id);
          await manager.closeSession(session.id);
          events.delete(session.id);
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
      await manager.closeSession(session.id);
      events.delete(session.id);
      console.info(`[realtime-sidecar] session cancelled ${session.id}`);
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
