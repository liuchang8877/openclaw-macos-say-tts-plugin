import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.ts";

function createHarness(pluginConfig = { defaultVoice: "Tingting" }) {
  const routes = [];
  plugin.register({
    id: "macos-say-tts",
    pluginConfig,
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

  async function invokeSpeech(body) {
    const req = {
      method: "POST",
      url: "/v1/audio/speech",
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) {
          yield Buffer.from(body);
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

    await speechRoute.handler(req, res);
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      json: res.body.length ? JSON.parse(res.body.toString("utf8")) : null,
    };
  }

  return { invokeSpeech };
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
