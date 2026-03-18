# openclaw-macos-say-tts-plugin

External OpenClaw plugin that exposes `POST /v1/audio/speech` and backs it with macOS `say`.

It also registers a `/tts` plugin command so IM channels such as Feishu can ask the gateway to synthesize speech and receive a WAV attachment in-chat.

## What it does

- Registers a gateway-authenticated `POST /v1/audio/speech`
- Registers a `/tts` plugin command for IM channels
- Accepts an OpenAI-compatible request body:
  - `input`
  - `voice`
  - `response_format` (`wav`, `aiff`, or `opus`)
  - `speed`
- Uses `say` to synthesize AIFF
- Uses `afconvert` to convert to WAV when requested
- Uses `ffmpeg` to convert to Opus when requested (required for Feishu native audio playback)
- Creates temporary tokenized media URLs for command replies

## API behavior

`POST /v1/audio/speech` accepts an OpenAI-compatible JSON body with:

- `input` required, must be a non-empty string
- `voice` optional, defaults to the configured `defaultVoice`
- `response_format` optional, supports `wav`, `aiff`, `opus`, and `ogg`
- `speed` optional, scales the configured `defaultRate`

Format behavior:

- Omitting `response_format` defaults to `wav`
- `ogg` is accepted as an alias of Opus and returns `audio/ogg; codecs=opus`
- Unsupported values such as `mp3` are rejected with `400`

Error behavior:

- `400` for invalid JSON bodies
- `400` for missing `input`
- `400` for unsupported `response_format`
- `400` for input longer than `maxInputChars`
- `413` for request bodies larger than 128 KiB
- `500` for synthesis or transcoding failures, with a generic `TTS generation failed.` message

## Installation

### 1. System dependencies

The plugin runs on **macOS only** and relies on three system commands:

| Command | Comes with | Purpose |
|---|---|---|
| `say` | macOS (built-in) | Text-to-speech synthesis |
| `afconvert` | macOS (built-in) | AIFF → WAV conversion |
| `ffmpeg` | Homebrew | AIFF → Opus conversion (for Feishu native audio) |

Install `ffmpeg` (includes `libopus`):

```bash
brew install ffmpeg
```

Verify `libopus` encoder is available:

```bash
ffmpeg -encoders 2>/dev/null | grep opus
# Expected output should include: libopus
```

### 2. Install the plugin into OpenClaw

Copy or symlink this directory into your OpenClaw plugins folder, then restart the gateway:

```bash
# Option A: symlink (recommended for development)
ln -s /path/to/openclaw-macos-say-tts-plugin ~/.openclaw/plugins/macos-say-tts

# Option B: copy
cp -r /path/to/openclaw-macos-say-tts-plugin ~/.openclaw/plugins/macos-say-tts

# Restart the gateway to load the plugin
openclaw restart
```

### 3. Configure

Add the plugin config to your OpenClaw configuration (e.g. `~/.openclaw/config.json`):

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

The plugin will synthesize audio, expose it on a temporary tokenized media route, and let the channel adapter upload it as an attachment reply.

> **Auto Opus for Feishu**: When invoked from a Feishu channel, the `/tts` command automatically outputs Opus format so that Feishu can render a native inline audio player. Other channels receive WAV.

Command behavior:

- Empty `/tts` input returns a usage error
- Text longer than `maxInputChars` is rejected before synthesis
- Feishu channels receive Opus media links; other channels receive WAV media links

## Notes

- The route uses `auth: "gateway"`, so it reuses OpenClaw gateway auth.
- Health check is exposed at `GET /plugins/macos-say-tts/health`.
- Temporary command media is exposed at `GET /plugins/macos-say-tts/media/:id/:token.wav`.
- `speed` is mapped to `say -r` by scaling the configured `defaultRate`.
- `commandMediaBaseUrl` should point at a gateway URL the OpenClaw host itself can fetch, typically `http://127.0.0.1:18789` or your reverse-proxied gateway URL.
- `response_format=opus` or `response_format=ogg` triggers `ffmpeg` transcoding to Opus. Useful for clients that require Opus, such as Feishu.
