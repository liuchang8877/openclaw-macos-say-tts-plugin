# openclaw-macos-say-tts-plugin

External OpenClaw plugin that exposes `POST /v1/audio/speech` and backs it with macOS `say`.

It also registers a `/tts` plugin command so IM channels such as Feishu can ask the gateway to synthesize speech and receive a WAV attachment in-chat.

## What it does

- Registers a gateway-authenticated `POST /v1/audio/speech`
- Registers a `/tts` plugin command for IM channels
- Accepts an OpenAI-compatible request body:
  - `input`
  - `voice`
  - `response_format` (`wav` or `aiff`)
  - `speed`
- Uses `say` to synthesize AIFF
- Uses `afconvert` to convert to WAV when requested
- Creates temporary tokenized media URLs for command replies

## Requirements

- macOS host
- `say` available in `PATH`
- `afconvert` available in `PATH`
- OpenClaw with plugin support

## Suggested config

```json
{
  "plugins": {
    "macos-say-tts": {
      "enabled": true,
      "defaultVoice": "Tingting",
      "defaultRate": 175,
      "sampleRate": 22050,
      "maxInputChars": 1200,
      "commandMediaBaseUrl": "http://127.0.0.1:18789",
      "mediaTtlSeconds": 900
    }
  }
}
```

## Pi-side config

Point the Pi TTS client at the same public OpenClaw gateway:

```bash
export ENABLE_TTS="true"
export OPENCLAW_BASE_URL="https://your-gateway.example.com"
export OPENCLAW_TOKEN="your-gateway-token"
export TTS_BASE_URL="https://your-gateway.example.com"
export TTS_API_TOKEN="your-gateway-token"
export TTS_HTTP_PATH="/v1/audio/speech"
```

## Feishu / IM usage

Once the plugin is installed and enabled, you can invoke it from chat with:

```text
/tts 你好，这是一个飞书里直接触发的语音合成测试。
```

The plugin will synthesize a WAV file, expose it on a temporary tokenized media route, and let the channel adapter upload it as an attachment reply.

## Notes

- The route uses `auth: "gateway"`, so it reuses OpenClaw gateway auth.
- Health check is exposed at `GET /plugins/macos-say-tts/health`.
- Temporary command media is exposed at `GET /plugins/macos-say-tts/media/:id/:token.wav`.
- `speed` is mapped to `say -r` by scaling the configured `defaultRate`.
- `commandMediaBaseUrl` should point at a gateway URL the OpenClaw host itself can fetch, typically `http://127.0.0.1:18789` or your reverse-proxied gateway URL.
