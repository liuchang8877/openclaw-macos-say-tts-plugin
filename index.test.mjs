import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.ts";

function createHarness(pluginConfig = { defaultVoice: "Tingting" }) {
  const routes = [];
  const transcribeCalls = [];
  plugin.register({
    id: "macos-say-tts",
    pluginConfig,
    config: {},
    runtime: {
      mediaUnderstanding: {
        async transcribeAudioFile(params) {
          transcribeCalls.push(params);
          return { text: "hello from openclaw" };
        },
      },
    },
    logger: {
      error() {},
      info() {},
    },
    registerHttpRoute(route) {
      routes.push(route);
    },
    registerCommand() {},
  });

  const speechRoute = routes.find((route) => route.path === "/v1/audio/speech");
  assert.ok(speechRoute, "speech route should be registered");
  const transcriptionRoute = routes.find((route) => route.path === "/v1/audio/transcriptions");
  assert.ok(transcriptionRoute, "transcription route should be registered");

  async function invokeRoute(route, params) {
    const req = {
      method: params.method ?? "POST",
      url: params.url,
      headers: params.headers ?? {},
      async *[Symbol.asyncIterator]() {
        if (params.body !== undefined) {
          yield params.body;
        }
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      },
      end(chunk) {
        if (chunk) {
          this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        }
      },
    };

    await route.handler(req, res);
    const text = res.body.toString("utf8");
    const isJson = String(res.headers["content-type"] || "").includes("application/json");
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      text,
      json: isJson && res.body.length ? JSON.parse(text) : null,
    };
  }

  async function invokeSpeech(body) {
    return await invokeRoute(speechRoute, {
      url: "/v1/audio/speech",
      body: body !== undefined ? Buffer.from(body) : undefined,
    });
  }

  async function invokeTranscription({ form }) {
    const request = new Request("http://127.0.0.1/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const body = Buffer.from(await request.arrayBuffer());
    return await invokeRoute(transcriptionRoute, {
      url: "/v1/audio/transcriptions",
      body,
      headers: {
        "content-type": request.headers.get("content-type"),
        "content-length": String(body.length),
      },
    });
  }

  return { invokeSpeech, invokeTranscription, transcribeCalls };
}

test("returns 400 for invalid JSON request bodies", async () => {
  const { invokeSpeech } = createHarness();
  const response = await invokeSpeech("{bad json");

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(response.json, {
    error: { message: "Invalid JSON body." },
  });
});

test("returns 413 for oversized request bodies", async () => {
  const { invokeSpeech } = createHarness();
  const largeBody = "a".repeat(128 * 1024 + 1);
  const response = await invokeSpeech(largeBody);

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json, {
    error: { message: "Request body too large." },
  });
});

test("returns 400 for unsupported response formats", async () => {
  const { invokeSpeech } = createHarness();
  const response = await invokeSpeech(JSON.stringify({
    input: "hello",
    response_format: "mp3",
  }));

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Unsupported `response_format`. Use `wav`, `aiff`, or `opus`." },
  });
});

test("returns 400 when transcription upload is missing file", async () => {
  const { invokeTranscription } = createHarness();
  const form = new FormData();
  form.set("response_format", "text");

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Missing `file` upload." },
  });
});

test("returns text/plain transcription output for response_format=text", async () => {
  const { invokeTranscription, transcribeCalls } = createHarness();
  const form = new FormData();
  form.set("response_format", "text");
  form.set("file", new File([Buffer.from("RIFFfake")], "utterance.wav", { type: "audio/wav" }));

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.text, "hello from openclaw");
  assert.equal(transcribeCalls.length, 1);
  assert.equal(transcribeCalls[0].mime, "audio/wav");
});

test("returns 400 for unsupported transcription response formats", async () => {
  const { invokeTranscription } = createHarness();
  const form = new FormData();
  form.set("response_format", "srt");
  form.set("file", new File([Buffer.from("RIFFfake")], "utterance.wav", { type: "audio/wav" }));

  const response = await invokeTranscription({ form });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: { message: "Unsupported `response_format`. Use `json`, `verbose_json`, or `text`." },
  });
});
