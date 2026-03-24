import { readFile } from "node:fs/promises";
import path from "node:path";

type ReplayOptions = {
  filePath: string;
  baseUrl: string;
  authToken?: string;
  chunkMs: number;
  tailSilenceMs: number;
  commitDelayMs: number;
  paceAudio: boolean;
  sampleRate?: number;
  channels: number;
  language?: string;
  enablePartial: boolean;
};

type LoadedAudio = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
};

function parseArgs(argv: string[]): ReplayOptions {
  const options: ReplayOptions = {
    filePath: "",
    baseUrl: process.env.REALTIME_REPLAY_BASE_URL || "http://127.0.0.1:8765",
    authToken: process.env.REALTIME_REPLAY_AUTH_TOKEN,
    chunkMs: Number(process.env.REALTIME_REPLAY_CHUNK_MS || "100"),
    tailSilenceMs: Number(process.env.REALTIME_REPLAY_TAIL_SILENCE_MS || "800"),
    commitDelayMs: Number(process.env.REALTIME_REPLAY_COMMIT_DELAY_MS || "0"),
    paceAudio: process.env.REALTIME_REPLAY_PACE !== "0",
    sampleRate: process.env.REALTIME_REPLAY_SAMPLE_RATE ? Number(process.env.REALTIME_REPLAY_SAMPLE_RATE) : undefined,
    channels: Number(process.env.REALTIME_REPLAY_CHANNELS || "1"),
    language: process.env.REALTIME_REPLAY_LANGUAGE || "zh",
    enablePartial: process.env.REALTIME_REPLAY_ENABLE_PARTIAL !== "0",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--file":
        options.filePath = next || "";
        index += 1;
        break;
      case "--base-url":
        options.baseUrl = next || options.baseUrl;
        index += 1;
        break;
      case "--auth-token":
        options.authToken = next || "";
        index += 1;
        break;
      case "--chunk-ms":
        options.chunkMs = Number(next || options.chunkMs);
        index += 1;
        break;
      case "--tail-silence-ms":
        options.tailSilenceMs = Number(next || options.tailSilenceMs);
        index += 1;
        break;
      case "--commit-delay-ms":
        options.commitDelayMs = Number(next || options.commitDelayMs);
        index += 1;
        break;
      case "--sample-rate":
        options.sampleRate = Number(next || options.sampleRate);
        index += 1;
        break;
      case "--channels":
        options.channels = Number(next || options.channels);
        index += 1;
        break;
      case "--language":
        options.language = next || "";
        index += 1;
        break;
      case "--fast":
        options.paceAudio = false;
        break;
      case "--no-partial":
        options.enablePartial = false;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (!arg.startsWith("--") && !options.filePath) {
          options.filePath = arg;
        }
        break;
    }
  }

  if (!options.filePath) {
    throw new Error("Missing audio file. Use --file /path/to/audio.wav");
  }
  if (!Number.isFinite(options.chunkMs) || options.chunkMs <= 0) {
    throw new Error("Invalid --chunk-ms.");
  }
  if (!Number.isFinite(options.tailSilenceMs) || options.tailSilenceMs < 0) {
    throw new Error("Invalid --tail-silence-ms.");
  }
  if (!Number.isFinite(options.commitDelayMs) || options.commitDelayMs < 0) {
    throw new Error("Invalid --commit-delay-ms.");
  }
  if (!Number.isFinite(options.channels) || options.channels !== 1) {
    throw new Error("Only mono audio is supported right now. Use --channels 1.");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: node realtime-replay.ts --file <audio.wav|audio.pcm> [options]

Options:
  --base-url <url>          Sidecar base URL. Default: http://127.0.0.1:8765
  --auth-token <token>      Bearer token for the sidecar.
  --chunk-ms <n>            Chunk size in milliseconds. Default: 100
  --tail-silence-ms <n>     Append silence before commit. Default: 800
  --commit-delay-ms <n>     Wait before commit after last chunk. Default: 0
  --sample-rate <n>         Required for raw PCM input when not 16000.
  --channels <n>            Required for raw PCM input. Default: 1
  --language <code>         Request language. Default: zh
  --fast                    Disable realtime pacing and send as fast as possible.
  --no-partial              Disable partial transcript requests.
`);
}

function parseWavPcmS16Le(buffer: Buffer): LoadedAudio {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Unsupported WAV file: missing RIFF/WAVE header.");
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let pcm = Buffer.alloc(0);

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      throw new Error(`Invalid WAV file: chunk ${chunkId} exceeds file size.`);
    }

    if (chunkId === "fmt ") {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      pcm = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV format ${audioFormat}; expected PCM (1).`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}; expected 16-bit PCM.`);
  }
  if (channels !== 1) {
    throw new Error(`Unsupported WAV channels ${channels}; expected mono.`);
  }
  if (!pcm.length) {
    throw new Error("WAV file does not contain a data chunk.");
  }

  return {
    pcm,
    sampleRate,
    channels,
  };
}

async function loadAudio(filePath: string, fallbackSampleRate: number | undefined, fallbackChannels: number): Promise<LoadedAudio> {
  const audio = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") {
    return parseWavPcmS16Le(audio);
  }

  const sampleRate = fallbackSampleRate ?? 16000;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Raw PCM input requires a valid --sample-rate.");
  }
  return {
    pcm: audio,
    sampleRate,
    channels: fallbackChannels,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkPcm(pcm: Buffer, sampleRate: number, channels: number, chunkMs: number): Buffer[] {
  const blockAlign = channels * 2;
  const chunkBytes = Math.max(
    blockAlign,
    Math.round((sampleRate * blockAlign * chunkMs) / 1000 / blockAlign) * blockAlign,
  );
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    chunks.push(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
  }
  return chunks;
}

async function postJson(baseUrl: string, authToken: string | undefined, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${baseUrl}/plugins/macos-say-tts/asr/realtime`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = await loadAudio(options.filePath, options.sampleRate, options.channels);
  const inputDurationMs = Math.round((loaded.pcm.length / (loaded.sampleRate * loaded.channels * 2)) * 1000);
  const chunks = chunkPcm(loaded.pcm, loaded.sampleRate, loaded.channels, options.chunkMs);

  console.log(
    `[realtime-replay] file=${options.filePath} sampleRate=${loaded.sampleRate} channels=${loaded.channels} ` +
      `bytes=${loaded.pcm.length} durationMs=${inputDurationMs} chunks=${chunks.length} ` +
      `chunkMs=${options.chunkMs} tailSilenceMs=${options.tailSilenceMs} pace=${options.paceAudio ? "realtime" : "fast"}`,
  );

  const startResponse = await postJson(options.baseUrl, options.authToken, {
    type: "session.start",
    audio_format: "pcm_s16le",
    sample_rate: loaded.sampleRate,
    channels: loaded.channels,
    language: options.language,
    enable_partial: options.enablePartial,
  }) as { session_id: string; chunk_ms?: number };

  const sessionId = startResponse.session_id;
  if (!sessionId) {
    throw new Error(`session.start did not return session_id: ${JSON.stringify(startResponse)}`);
  }
  console.log(`[realtime-replay] session.start sessionId=${sessionId} sidecarChunkMs=${startResponse.chunk_ms ?? "unknown"}`);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await postJson(options.baseUrl, options.authToken, {
      type: "audio.append",
      session_id: sessionId,
      audio_base64: chunk.toString("base64"),
    });
    console.log(`[realtime-replay] audio.append index=${index + 1}/${chunks.length} bytes=${chunk.length}`);
    if (options.paceAudio) {
      await sleep(options.chunkMs);
    }
  }

  if (options.tailSilenceMs > 0) {
    const silenceBytes = Math.round((loaded.sampleRate * loaded.channels * 2 * options.tailSilenceMs) / 1000);
    const silence = Buffer.alloc(silenceBytes);
    const silenceChunks = chunkPcm(silence, loaded.sampleRate, loaded.channels, options.chunkMs);
    for (let index = 0; index < silenceChunks.length; index += 1) {
      const chunk = silenceChunks[index];
      await postJson(options.baseUrl, options.authToken, {
        type: "audio.append",
        session_id: sessionId,
        audio_base64: chunk.toString("base64"),
      });
      console.log(`[realtime-replay] silence.append index=${index + 1}/${silenceChunks.length} bytes=${chunk.length}`);
      if (options.paceAudio) {
        await sleep(options.chunkMs);
      }
    }
  }

  if (options.commitDelayMs > 0) {
    console.log(`[realtime-replay] waiting commitDelayMs=${options.commitDelayMs}`);
    await sleep(options.commitDelayMs);
  }

  const commitResponse = await postJson(options.baseUrl, options.authToken, {
    type: "session.commit",
    session_id: sessionId,
  }) as { final_text?: string; events?: unknown[] };

  console.log(
    `[realtime-replay] session.commit sessionId=${sessionId} finalText=${JSON.stringify(commitResponse.final_text || "")} ` +
      `events=${JSON.stringify(commitResponse.events || [])}`,
  );
}

main().catch((error) => {
  console.error("[realtime-replay] failed", error);
  process.exitCode = 1;
});
