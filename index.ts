import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/core";

const execFileAsync = promisify(execFile);
const AUDIO_PATH = "/v1/audio/speech";
const HEALTH_PATH = "/plugins/macos-say-tts/health";
const MAX_BODY_BYTES = 128 * 1024;

type PluginConfig = {
  defaultVoice?: string;
  defaultRate?: number;
  sampleRate?: number;
  maxInputChars?: number;
};

type SpeechRequest = {
  input?: unknown;
  voice?: unknown;
  response_format?: unknown;
  speed?: unknown;
};

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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as SpeechRequest;
}

function resolveResponseFormat(value: unknown): "wav" | "aiff" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "aiff" ? "aiff" : "wav";
}

function resolveSpeechRate(defaultRate: number, speed: unknown): number {
  if (typeof speed !== "number" || !Number.isFinite(speed)) {
    return defaultRate;
  }
  const normalizedSpeed = Math.min(4, Math.max(0.25, speed));
  return Math.round(defaultRate * normalizedSpeed);
}

async function synthesizeWithSay(params: {
  text: string;
  voice: string;
  rate: number;
  responseFormat: "wav" | "aiff";
  sampleRate: number;
}): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-macos-say-tts-"));
  const aiffPath = path.join(dir, "speech.aiff");
  const outPath = path.join(dir, params.responseFormat === "wav" ? "speech.wav" : "speech.aiff");

  try {
    await execFileAsync("say", ["-v", params.voice, "-r", String(params.rate), "-o", aiffPath, params.text], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    if (params.responseFormat === "wav") {
      await execFileAsync(
        "afconvert",
        ["-f", "WAVE", "-d", `LEI16@${params.sampleRate}`, aiffPath, outPath],
        {
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return await readFile(outPath);
    }

    return await readFile(aiffPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createSpeechHandler(api: OpenClawPluginApi): OpenClawPluginHttpRouteHandler {
  const config = (api.pluginConfig ?? {}) as PluginConfig;
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
      res.setHeader("content-type", responseFormat === "wav" ? "audio/wav" : "audio/aiff");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(audio);
      return true;
    } catch (error) {
      api.logger.error(`macos-say-tts synth failed: ${String(error)}`);
      respondJson(res, 500, { error: { message: String(error) } });
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
      voice: ((api.pluginConfig ?? {}) as PluginConfig).defaultVoice ?? "Tingting",
    });
    return true;
  };
}

const plugin = {
  id: "macos-say-tts",
  name: "macOS Say TTS",
  description: "Expose /v1/audio/speech using macOS say and afconvert.",
  register(api: OpenClawPluginApi) {
    api.registerHttpRoute({
      path: AUDIO_PATH,
      auth: "gateway",
      handler: createSpeechHandler(api),
    });
    api.registerHttpRoute({
      path: HEALTH_PATH,
      auth: "plugin",
      handler: createHealthHandler(api),
    });
  },
};

export default plugin;
