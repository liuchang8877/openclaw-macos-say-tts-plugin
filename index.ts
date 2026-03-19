import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/core";

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
  transcriptionBackend?: "local-whisper" | "openclaw-runtime";
  transcriptionCommand?: string;
  transcriptionModel?: string;
  transcriptionTimeoutSeconds?: number;
  commandMediaBaseUrl?: string;
  mediaTtlSeconds?: number;
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
  responseFormat: "json" | "text";
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
  return {
    file: uploaded,
    mime,
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
  timeoutSeconds: number;
}): Promise<string> {
  const outputDir = await mkdtemp(path.join(tmpdir(), "openclaw-macos-say-stt-out-"));
  try {
    await execFileAsync(
      params.command,
      [
        "--model",
        params.model,
        "--output_format",
        "txt",
        "--output_dir",
        outputDir,
        "--verbose",
        "False",
        params.filePath,
      ],
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
}): Promise<string> {
  const backend = params.config.transcriptionBackend ?? "local-whisper";
  if (backend === "openclaw-runtime") {
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
  const timeoutSeconds =
    typeof params.config.transcriptionTimeoutSeconds === "number" &&
    Number.isFinite(params.config.transcriptionTimeoutSeconds)
      ? Math.max(10, Math.round(params.config.transcriptionTimeoutSeconds))
      : 120;
  return await transcribeWithWhisper({
    filePath: params.filePath,
    command,
    model,
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
    respondJson(res, 200, {
      ok: true,
      plugin: api.id,
      speechPath: AUDIO_PATH,
      transcriptionPath: TRANSCRIPTIONS_PATH,
      voice: ((api.pluginConfig ?? {}) as PluginConfig).defaultVoice ?? "Tingting",
    });
    return true;
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
      path: MEDIA_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: createMediaHandler(api, state),
    });
    api.registerCommand(createTtsCommand({ api, config, state }));
  },
};

export default plugin;
