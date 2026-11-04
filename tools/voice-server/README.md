# Voice server

Transcribes recordings from the Android app on this computer's GPU with whisper.cpp. It runs next to T3 Code and changes nothing in it: messages go out through the `t3` CLI, so a busy thread gets them as its next turn.

Needs Node 24, ffmpeg, a whisper.cpp build and a model such as `ggml-large-v3-turbo-q5_0.bin`. Pass a Silero model with `-VadModel` (for example `ggml-silero-v6.2.0.bin`) so a recording without speech is not turned into invented text and sent.

## Install (Windows)

```powershell
.\scripts\install.ps1 -WhisperDirectory C:\path\to\whisper -Model C:\path\to\model.bin -Ffmpeg C:\path\to\ffmpeg.exe
```

This copies the service to `~/.t3-voice/app`, writes `~/.t3-voice/config.json` once, and starts a scheduled task at logon. Logs go to `~/.t3-voice/service.log`.

## Pair a phone

```powershell
node ~/.t3-voice/app/src/main.ts pair
```

Open the printed link on the phone, or paste it under Settings → Microphone → Voice server. Each run creates a new device token and stores only its hash. To revoke a phone, remove its hash from `tokenHashes` in the config and restart the task.

## How it behaves

- Recordings run one at a time, in order. Nothing stays in RAM or VRAM between them.
- The phone gets its success only after the audio is on disk here; jobs survive a restart of the service.
- A failing transcription retries, then ends as failed with the audio kept. Sending retries for as long as T3 is unreachable.
- Finished jobs are removed after 14 days.

## Reachability

With `tunnelName` set, the service keeps an ssh tunnel open through the `devtunnel` host, so the phone reaches it from anywhere. The URL is public; the device token is what protects it. A leaked token lets its holder send messages to your threads, so treat it like a password.

## Tests

```sh
node --test test/*.test.ts
```
