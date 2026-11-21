# Voice server

Transcribes recordings from the Android app on this computer's GPU with whisper.cpp. It runs next to T3 Code and changes nothing in it: messages go out through the `t3` CLI, so a busy thread gets them as its next turn.

Needs Node 24, ffmpeg, a whisper.cpp build and a model such as `ggml-large-v3-turbo-q5_0.bin`. Pass a Silero model with `-VadModel` (for example `ggml-silero-v6.2.0.bin`) so a recording without speech is not turned into invented text and sent.

## Install (Windows)

```powershell
.\scripts\install.ps1 -WhisperDirectory C:\path\to\whisper -Model C:\path\to\model.bin -Ffmpeg C:\path\to\ffmpeg.exe
```

This copies the service to `~/.t3-voice/app`, writes `~/.t3-voice/config.json` once, and starts a scheduled task at logon. Logs go to `~/.t3-voice/service.log`.

## How the phone reaches it

The service listens on loopback only. At start it writes `~/.t3-voice/t3-link.json` with its port, a fresh token and the environment it sends into. The T3 server of that environment reads the file and proxies `/api/voice/*` here, so the phone uses the connection it already has to T3 (LAN, Tailscale or T3 Connect) and needs no pairing. A T3 server of another environment, such as a dev server, offers no voice service.

The name in `[Voice message from Nils]` is the author name set on the phone. Clients hide the marker. Without a name the marker stays `[Voice message]`.

## How it behaves

- Recordings run one at a time, in order.
- The model loads when a recording starts and unloads after two minutes without use (`whisperIdleSeconds`), so an idle PC holds no RAM or VRAM for it. If that server fails, the job falls back to `whisper-cli`.
- While someone records, the app streams the growing file and shows a live preview. It is a quick, greedy pass that yields to finished recordings; the text that counts always comes from the full upload. Preview audio is deleted when the upload arrives, after five idle minutes, or at the next service start.
- The phone gets its success only after the audio is on disk here; jobs survive a restart of the service.
- A failing transcription retries, then ends as failed with the audio kept. Sending retries for as long as T3 is unreachable.
- A recording whisper mostly had to guess (a covered or distant mic, heavy noise) ends as failed at once instead of sending invented words. Retry on the phone transcribes it anyway.
- Once the audio is here the phone is done: this service sends every message, also one that steers the running agent (`t3 thread send --mode auto`) and a dictation the app hands over when its message was sent from the composer before the words arrived (`POST /v1/jobs/:id/send`). Only messages with attachments or for a chat that does not exist yet still leave from the phone. Steering needs a T3 CLI with `--mode`.
- Finished jobs are removed after 14 days.

## Vocabulary

Whisper has no real dictionary, so `~/.t3-voice/vocabulary.json` works in two steps. It is read for every recording, so changes need no restart.

- `prompt` is text whisper continues from. Write a sentence that uses the names: it works clearly better than a bare list. Keep it short, whisper reads at most 224 tokens.
- `corrections` maps a right spelling to what whisper writes instead, for names the prompt does not fix. Only whole words are replaced, in any case.

```json
{
  "prompt": "Gespräch über unsere Apps Pidohr und dialed.",
  "corrections": { "Pidohr": ["Pidor"] }
}
```

Do not pass `-mc 0` in `whisperArgs`: whisper.cpp then drops the prompt without a word. A prompt can also be repeated back on audio without speech, which the Silero gate catches, so keep `-VadModel` set.

## Tests

```sh
node --test test/*.test.ts
```
