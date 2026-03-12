# openclaw-macos-say-tts-plugin

External OpenClaw plugin that exposes `POST /v1/audio/speech` and backs it with macOS `say`.

## What it does

- Registers a gateway-authenticated `POST /v1/audio/speech`
- Accepts an OpenAI-compatible request body:
  - `input`
  - `voice`
  - `response_format` (`wav` or `aiff`)
  - `speed`
- Uses `say` to synthesize AIFF
- Uses `afconvert` to convert to WAV when requested

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
      "maxInputChars": 1200
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

## Notes

- The route uses `auth: "gateway"`, so it reuses OpenClaw gateway auth.
- Health check is exposed at `GET /plugins/macos-say-tts/health`.
- `speed` is mapped to `say -r` by scaling the configured `defaultRate`.
