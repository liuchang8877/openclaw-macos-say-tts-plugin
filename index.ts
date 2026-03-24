import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/core";
import {
  REALTIME_ASR_PATH,
  getRealtimeCapability,
} from "./realtime.ts";

const execFileAsync = promisify(execFile);
const AUDIO_PATH = "/v1/audio/speech";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
const HEALTH_PATH = "/plugins/macos-say-tts/health";
const MEDIA_PREFIX = "/plugins/macos-say-tts/media/";
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const DEFAULT_MEDIA_BASE_URL = "http://127.0.0.1:18789";
const DEFAULT_MEDIA_TTL_SECONDS = 900;

type PluginConfig = {
  defaultVoice?: string;
  defaultRate?: number;
  sampleRate?: number;
  maxInputChars?: number;
  maxAudioBytes?: number;
  transcriptionBackend?: "local-whisper" | "openclaw-runtime" | "doubao-realtime";
  transcriptionCommand?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
  transcriptionTimeoutSeconds?: number;
  commandMediaBaseUrl?: string;
  mediaTtlSeconds?: number;
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
  realtimeSidecarBaseUrl?: string;
  realtimeSidecarAuthToken?: string;
};

type SpeechRequest = {
  input?: unknown;
  voice?: unknown;
  response_format?: unknown;
  speed?: unknown;
};

type StoredMedia = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
  token: string;
  expiresAt: number;
};

type TranscriptionRequest = {
  file: File;
  mime?: string;
  language?: string;
  responseFormat: "json" | "text";
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

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function respondText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<SpeechRequest> {
  const raw = await readRequestBody(req, MAX_BODY_BYTES);
  if (!raw.length) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf-8").trim()) as SpeechRequest;
  } catch {
    throw new RequestValidationError(400, "Invalid JSON body.");
  }
}

async function readJsonBodyAny(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req, DEFAULT_MAX_AUDIO_BYTES);
  return parseJsonObject(raw);
}

function parseJsonObject(raw: Buffer): Record<string, unknown> {
  if (!raw.length) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf-8").trim()) as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(400, "Invalid JSON body.");
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
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

function buildRequestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readMultipartForm(req: IncomingMessage, maxBytes: number): Promise<FormData> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
    throw new RequestValidationError(400, "Expected multipart/form-data request body.");
  }
  const body = await readRequestBody(req, maxBytes);
  try {
    const request = new Request("http://127.0.0.1/upload", {
      method: req.method ?? "POST",
      headers: buildRequestHeaders(req),
      body,
    });
    return await request.formData();
  } catch {
    throw new RequestValidationError(400, "Invalid multipart/form-data body.");
  }
}

function resolveResponseFormat(value: unknown): "wav" | "aiff" | "opus" {
  if (value === undefined || value === null || value === "") {
    return "wav";
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(400, "Invalid `response_format`. Use `wav`, `aiff`, or `opus`.");
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "wav") return "wav";
  if (normalized === "aiff") return "aiff";
  if (normalized === "opus" || normalized === "ogg") return "opus";
  throw new RequestValidationError(400, "Unsupported `response_format`. Use `wav`, `aiff`, or `opus`.");
}

function resolveSpeechRate(defaultRate: number, speed: unknown): number {
  if (typeof speed !== "number" || !Number.isFinite(speed)) {
    return defaultRate;
  }
  const normalizedSpeed = Math.min(4, Math.max(0.25, speed));
  return Math.round(defaultRate * normalizedSpeed);
}

function resolveTranscriptionResponseFormat(value: FormDataEntryValue | null): "json" | "text" {
  if (typeof value !== "string" || !value.trim()) {
    return "json";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "json" || normalized === "verbose_json") return "json";
  if (normalized === "text") return "text";
  throw new RequestValidationError(
    400,
    "Unsupported `response_format`. Use `json`, `verbose_json`, or `text`.",
  );
}

function resolveOptionalFormString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
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
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
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

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getRealtimeProxyConfig(config: PluginConfig) {
  const capability = getRealtimeCapability(config);
  const sidecarBaseUrl = normalizeTrimmedString(config.realtimeSidecarBaseUrl).replace(/\/+$/, "");
  const sidecarAuthToken = normalizeTrimmedString(config.realtimeSidecarAuthToken);
  return {
    enabled: capability.backend === "doubao-realtime",
    configured: Boolean(sidecarBaseUrl),
    backend: capability.backend,
    chunkMs: capability.chunkMs,
    sidecarBaseUrl,
    sidecarAuthToken,
  };
}

async function proxyRealtimeRequest(params: {
  rawBody: Buffer;
  config: PluginConfig;
}): Promise<Response> {
  const proxyConfig = getRealtimeProxyConfig(params.config);
  if (!proxyConfig.sidecarBaseUrl) {
    throw new RequestValidationError(
      503,
      "Realtime STT sidecar is not configured. Set `realtimeSidecarBaseUrl` in the plugin config.",
    );
  }

  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (proxyConfig.sidecarAuthToken) {
    headers.set("authorization", `Bearer ${proxyConfig.sidecarAuthToken}`);
  }

  return await fetch(`${proxyConfig.sidecarBaseUrl}${REALTIME_ASR_PATH}`, {
    method: "POST",
    headers,
    body: params.rawBody,
  });
}

async function relayFetchResponse(res: ServerResponse, upstream: Response): Promise<void> {
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase() === "transfer-encoding") {
      return;
    }
    res.setHeader(name, value);
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const hasContentLength = typeof res.getHeader === "function"
    ? Boolean(res.getHeader("content-length"))
    : false;
  if (!hasContentLength) {
    res.setHeader("content-length", String(body.length));
  }
  res.end(body);
}

function inferMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".flac") return "audio/flac";
  return undefined;
}

async function readTranscriptionRequest(req: IncomingMessage, maxAudioBytes: number): Promise<TranscriptionRequest> {
  const form = await readMultipartForm(req, maxAudioBytes);
  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) {
    throw new RequestValidationError(400, "Missing `file` upload.");
  }
  if (uploaded.size <= 0) {
    throw new RequestValidationError(400, "Uploaded audio file is empty.");
  }

  const responseFormat = resolveTranscriptionResponseFormat(form.get("response_format"));
  const fileName = uploaded.name?.trim() || "audio.bin";
  const mime = uploaded.type?.trim() || inferMimeType(fileName);
  const language = resolveOptionalFormString(form.get("language"));
  return {
    file: uploaded,
    mime,
    language,
    responseFormat,
  };
}

async function synthesizeWithSay(params: {
  text: string;
  voice: string;
  rate: number;
  responseFormat: "wav" | "aiff" | "opus";
  sampleRate: number;
}): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-macos-say-tts-"));
  const aiffPath = path.join(dir, "speech.aiff");

  try {
    await execFileAsync("say", ["-v", params.voice, "-r", String(params.rate), "-o", aiffPath, params.text], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    if (params.responseFormat === "wav") {
      const wavPath = path.join(dir, "speech.wav");
      await execFileAsync(
        "afconvert",
        ["-f", "WAVE", "-d", `LEI16@${params.sampleRate}`, aiffPath, wavPath],
        {
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return await readFile(wavPath);
    }

    if (params.responseFormat === "opus") {
      const opusPath = path.join(dir, "speech.opus");
      await execFileAsync(
        "ffmpeg",
        ["-y", "-i", aiffPath, "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1", opusPath],
        {
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return await readFile(opusPath);
    }

    return await readFile(aiffPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeWithWhisper(params: {
  filePath: string;
  command: string;
  model: string;
  language?: string;
  timeoutSeconds: number;
}): Promise<string> {
  const outputDir = await mkdtemp(path.join(tmpdir(), "openclaw-macos-say-stt-out-"));
  try {
    const args = [
      "--model",
      params.model,
      "--output_format",
      "txt",
      "--output_dir",
      outputDir,
      "--verbose",
      "False",
    ];
    if (params.language) {
      args.push("--language", params.language);
    }
    args.push(params.filePath);
    await execFileAsync(
      params.command,
      args,
      {
        timeout: Math.max(10, params.timeoutSeconds) * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const outputBase = path.basename(params.filePath, path.extname(params.filePath));
    const transcriptPath = path.join(outputDir, `${outputBase}.txt`);
    const text = (await readFile(transcriptPath, "utf8")).trim();
    return text;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function transcribeAudio(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  filePath: string;
  mime?: string;
  language?: string;
}): Promise<string> {
  const backend = params.config.transcriptionBackend ?? "local-whisper";
  if (backend === "openclaw-runtime" || backend === "doubao-realtime") {
    const result = await params.api.runtime.mediaUnderstanding.transcribeAudioFile({
      filePath: params.filePath,
      cfg: params.api.config,
      mime: params.mime,
    });
    return result.text?.trim() ?? "";
  }

  const command =
    typeof params.config.transcriptionCommand === "string" && params.config.transcriptionCommand.trim()
      ? params.config.transcriptionCommand.trim()
      : "whisper";
  const model =
    typeof params.config.transcriptionModel === "string" && params.config.transcriptionModel.trim()
      ? params.config.transcriptionModel.trim()
      : "turbo";
  const language =
    params.language ??
    (typeof params.config.transcriptionLanguage === "string" && params.config.transcriptionLanguage.trim()
      ? params.config.transcriptionLanguage.trim()
      : undefined);
  const timeoutSeconds =
    typeof params.config.transcriptionTimeoutSeconds === "number" &&
    Number.isFinite(params.config.transcriptionTimeoutSeconds)
      ? Math.max(10, Math.round(params.config.transcriptionTimeoutSeconds))
      : 120;
  return await transcribeWithWhisper({
    filePath: params.filePath,
    command,
    model,
    language,
    timeoutSeconds,
  });
}

function buildMediaUrl(baseUrl: string, id: string, token: string, ext: string = "wav"): string {
  return `${baseUrl.replace(/\/+$/, "")}${MEDIA_PREFIX}${id}/${token}.${ext}`;
}

function normalizeMediaBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_MEDIA_BASE_URL;
  }
  return value.trim().replace(/\/+$/, "");
}

function buildPluginState(config: PluginConfig) {
  const media = new Map<string, StoredMedia>();
  const mediaBaseUrl = normalizeMediaBaseUrl(config.commandMediaBaseUrl);
  const mediaTtlSeconds =
    typeof config.mediaTtlSeconds === "number" && Number.isFinite(config.mediaTtlSeconds)
      ? Math.max(60, Math.min(86400, Math.round(config.mediaTtlSeconds)))
      : DEFAULT_MEDIA_TTL_SECONDS;

  function pruneExpiredMedia() {
    const now = Date.now();
    for (const [id, entry] of media) {
      if (entry.expiresAt <= now) {
        media.delete(id);
      }
    }
  }

  function storeMedia(buffer: Buffer, contentType: string, fileName: string): string {
    pruneExpiredMedia();
    const id = randomUUID();
    const token = randomBytes(18).toString("hex");
    media.set(id, {
      buffer,
      contentType,
      fileName,
      token,
      expiresAt: Date.now() + mediaTtlSeconds * 1000,
    });
    const ext = path.extname(fileName).replace(/^\./, "") || "wav";
    return buildMediaUrl(mediaBaseUrl, id, token, ext);
  }

  function resolveMedia(pathname: string): StoredMedia | null {
    pruneExpiredMedia();
    if (!pathname.startsWith(MEDIA_PREFIX)) {
      return null;
    }
    const rest = pathname.slice(MEDIA_PREFIX.length);
    const [id, tokenWithExt] = rest.split("/");
    const token = tokenWithExt?.replace(/\.(wav|opus|ogg|aiff)$/i, "");
    if (!id || !token) {
      return null;
    }
    const entry = media.get(id);
    if (!entry || entry.token !== token || entry.expiresAt <= Date.now()) {
      media.delete(id);
      return null;
    }
    return entry;
  }

  return {
    mediaBaseUrl,
    storeMedia,
    resolveMedia,
    pruneExpiredMedia,
  };
}

function createSpeechHandler(api: OpenClawPluginApi, config: PluginConfig): OpenClawPluginHttpRouteHandler {
  const defaultVoice = typeof config.defaultVoice === "string" && config.defaultVoice.trim()
    ? config.defaultVoice.trim()
    : "Tingting";
  const defaultRate = typeof config.defaultRate === "number" && Number.isFinite(config.defaultRate)
    ? config.defaultRate
    : 175;
  const sampleRate = typeof config.sampleRate === "number" && Number.isFinite(config.sampleRate)
    ? config.sampleRate
    : 22050;
  const maxInputChars = typeof config.maxInputChars === "number" && Number.isFinite(config.maxInputChars)
    ? config.maxInputChars
    : 1200;

  return async (req, res) => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || parsed.pathname !== AUDIO_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      respondText(res, 405, "Method not allowed");
      return true;
    }

    try {
      const body = await readJsonBody(req);
      const text = typeof body.input === "string" ? body.input.trim() : "";
      const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : defaultVoice;

      if (!text) {
        respondJson(res, 400, { error: { message: "Missing `input` text." } });
        return true;
      }
      if (text.length > maxInputChars) {
        respondJson(res, 400, {
          error: { message: `Input too long. Max ${maxInputChars} characters.` },
        });
        return true;
      }

      const responseFormat = resolveResponseFormat(body.response_format);
      const rate = resolveSpeechRate(defaultRate, body.speed);
      const audio = await synthesizeWithSay({
        text,
        voice,
        rate,
        responseFormat,
        sampleRate,
      });

      res.statusCode = 200;
      res.setHeader("cache-control", "no-store, max-age=0");
      res.setHeader("content-length", String(audio.length));
      const contentType = responseFormat === "wav" ? "audio/wav" : responseFormat === "opus" ? "audio/ogg; codecs=opus" : "audio/aiff";
      res.setHeader("content-type", contentType);
      res.setHeader("x-content-type-options", "nosniff");
      res.end(audio);
      return true;
    } catch (error) {
      if (error instanceof RequestValidationError) {
        respondJson(res, error.statusCode, { error: { message: error.message } });
        return true;
      }
      api.logger.error(`macos-say-tts synth failed: ${String(error)}`);
      respondJson(res, 500, { error: { message: "TTS generation failed." } });
      return true;
    }
  };
}

function createTranscriptionHandler(api: OpenClawPluginApi, config: PluginConfig): OpenClawPluginHttpRouteHandler {
  const maxAudioBytes =
    typeof config.maxAudioBytes === "number" && Number.isFinite(config.maxAudioBytes)
      ? Math.max(256 * 1024, Math.round(config.maxAudioBytes))
      : DEFAULT_MAX_AUDIO_BYTES;

  return async (req, res) => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || parsed.pathname !== TRANSCRIPTIONS_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      respondText(res, 405, "Method not allowed");
      return true;
    }

    try {
      const upload = await readTranscriptionRequest(req, maxAudioBytes);
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-macos-say-stt-"));
      try {
        const originalName = path.basename(upload.file.name?.trim() || "audio.bin");
        const ext = path.extname(originalName) || ".bin";
        const filePath = path.join(dir, `upload${ext}`);
        const bytes = Buffer.from(await upload.file.arrayBuffer());
        await writeFile(filePath, bytes);
        const text = await transcribeAudio({
          api,
          config,
          filePath,
          mime: upload.mime,
          language: upload.language,
        });

        if (upload.responseFormat === "text") {
          respondText(res, 200, text);
        } else {
          respondJson(res, 200, { text });
        }
        return true;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof RequestValidationError) {
        respondJson(res, error.statusCode, { error: { message: error.message } });
        return true;
      }
      api.logger.error(`macos-say-tts transcribe failed: ${String(error)}`);
      respondJson(res, 500, { error: { message: "Audio transcription failed." } });
      return true;
    }
  };
}

function createHealthHandler(api: OpenClawPluginApi): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || parsed.pathname !== HEALTH_PATH) {
      return false;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      respondText(res, 405, "Method not allowed");
      return true;
    }
    const proxyConfig = getRealtimeProxyConfig((api.pluginConfig ?? {}) as PluginConfig);
    respondJson(res, 200, {
      ok: true,
      plugin: api.id,
      speechPath: AUDIO_PATH,
      transcriptionPath: TRANSCRIPTIONS_PATH,
      realtimePath: REALTIME_ASR_PATH,
      voice: ((api.pluginConfig ?? {}) as PluginConfig).defaultVoice ?? "Tingting",
      realtimeEnabled: proxyConfig.enabled,
      realtimeConfigured: proxyConfig.configured,
      realtimeBackend: proxyConfig.backend,
    });
    return true;
  };
}

function createRealtimeAsrHandler(
  api: OpenClawPluginApi,
  config: PluginConfig,
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || parsed.pathname !== REALTIME_ASR_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      respondText(res, 405, "Method not allowed");
      return true;
    }

    try {
      const proxyConfig = getRealtimeProxyConfig(config);
      if (!proxyConfig.enabled) {
        respondJson(res, 409, {
          error: {
            message: "Realtime STT is disabled. Set `transcriptionBackend` to `doubao-realtime`.",
          },
        });
        return true;
      }
      const rawBody = await readRequestBody(req, DEFAULT_MAX_AUDIO_BYTES);
      const body = parseJsonObject(rawBody) as RealtimeActionRequest;
      const action = resolveRealtimeActionType(body.type);
      if (action === "session.start") {
        resolveRealtimeAudioFormat(body.audio_format);
        resolveSampleRate(body.sample_rate);
        resolveChannels(body.channels);
        resolveRealtimeLanguage(body.language);
        resolveBoolean(body.enable_partial, true);
      } else {
        resolveRealtimeSessionId(body.session_id);
        if (action === "audio.append") {
          if (typeof body.audio_base64 !== "string" || !body.audio_base64.trim()) {
            throw new RequestValidationError(400, "Missing `audio_base64`.");
          }
        }
      }

      const startedAt = Date.now();
      const upstream = await proxyRealtimeRequest({ rawBody, config });
      if (action === "session.start") {
        api.logger.info(`macos-say-tts realtime sidecar session.start responded in ${Date.now() - startedAt}ms`);
      } else if (action === "audio.append") {
        api.logger.info(`macos-say-tts realtime sidecar audio.append responded in ${Date.now() - startedAt}ms`);
      } else if (action === "session.commit") {
        api.logger.info(`macos-say-tts realtime sidecar session.commit responded in ${Date.now() - startedAt}ms`);
      }
      await relayFetchResponse(res, upstream);
      return true;
    } catch (error) {
      if (error instanceof RequestValidationError) {
        respondJson(res, error.statusCode, { error: { message: error.message } });
        return true;
      }
      api.logger.error(`macos-say-tts realtime route failed: ${String(error)}`);
      respondJson(res, 500, { error: { message: "Realtime STT request failed." } });
      return true;
    }
  };
}

function createMediaHandler(
  api: OpenClawPluginApi,
  state: ReturnType<typeof buildPluginState>,
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || !parsed.pathname.startsWith(MEDIA_PREFIX)) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      respondText(res, 405, "Method not allowed");
      return true;
    }
    const entry = state.resolveMedia(parsed.pathname);
    if (!entry) {
      respondText(res, 404, "Media not found");
      return true;
    }
    res.statusCode = 200;
    res.setHeader("cache-control", "private, max-age=60");
    res.setHeader("content-type", entry.contentType);
    res.setHeader("content-length", String(entry.buffer.length));
    res.setHeader("content-disposition", `inline; filename="${entry.fileName}"`);
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(entry.buffer);
    }
    return true;
  };
}

function createTtsCommand(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  state: ReturnType<typeof buildPluginState>;
}) {
  const defaultVoice = typeof params.config.defaultVoice === "string" && params.config.defaultVoice.trim()
    ? params.config.defaultVoice.trim()
    : "Tingting";
  const defaultRate =
    typeof params.config.defaultRate === "number" && Number.isFinite(params.config.defaultRate)
      ? params.config.defaultRate
      : 175;
  const sampleRate =
    typeof params.config.sampleRate === "number" && Number.isFinite(params.config.sampleRate)
      ? params.config.sampleRate
      : 22050;
  const maxInputChars =
    typeof params.config.maxInputChars === "number" && Number.isFinite(params.config.maxInputChars)
      ? params.config.maxInputChars
      : 1200;

  return {
    name: "tts",
    nativeNames: { default: "tts" },
    description: "Generate speech audio from text (auto Opus for Feishu, WAV otherwise).",
    acceptsArgs: true,
    handler: async (ctx: {
      args?: string;
      channel: string;
    }) => {
      const text = ctx.args?.trim() ?? "";
      if (!text) {
        return {
          text: "Usage: /tts 你好，今天想说什么？",
          isError: true,
        };
      }
      if (text.length > maxInputChars) {
        return {
          text: `Text is too long. Max ${maxInputChars} characters.`,
          isError: true,
        };
      }

      try {
        const isFeishu = ctx.channel === "feishu";
        const responseFormat = isFeishu ? "opus" : "wav";
        const audio = await synthesizeWithSay({
          text,
          voice: defaultVoice,
          rate: defaultRate,
          responseFormat,
          sampleRate,
        });
        const mimeType = isFeishu ? "audio/ogg; codecs=opus" : "audio/wav";
        const ext = isFeishu ? "opus" : "wav";
        const mediaUrl = params.state.storeMedia(
          audio,
          mimeType,
          `tts-${Date.now()}.${ext}`,
        );
        return {
          text: `TTS ready${isFeishu ? " (Opus audio)" : ""}.`,
          mediaUrl,
        };
      } catch (error) {
        params.api.logger.error(`macos-say-tts command failed: ${String(error)}`);
        return {
          text: `TTS generation failed: ${String(error)}`,
          isError: true,
        };
      }
    },
  };
}

const plugin = {
  id: "macos-say-tts",
  name: "macOS Say TTS",
  description: "Expose /v1/audio/speech and /v1/audio/transcriptions through OpenClaw.",
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const state = buildPluginState(config);
    api.registerHttpRoute({
      path: AUDIO_PATH,
      auth: "gateway",
      handler: createSpeechHandler(api, config),
    });
    api.registerHttpRoute({
      path: TRANSCRIPTIONS_PATH,
      auth: "gateway",
      handler: createTranscriptionHandler(api, config),
    });
    api.registerHttpRoute({
      path: HEALTH_PATH,
      auth: "plugin",
      handler: createHealthHandler(api),
    });
    api.registerHttpRoute({
      path: REALTIME_ASR_PATH,
      auth: "gateway",
      handler: createRealtimeAsrHandler(api, config),
    });
    api.registerHttpRoute({
      path: MEDIA_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: createMediaHandler(api, state),
    });
    api.registerCommand(createTtsCommand({ api, config, state }));
  },
};

export default plugin;
