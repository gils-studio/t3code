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

- Recordings run one at a time, in order.
- The model loads when a recording starts and unloads after two minutes without use (`whisperIdleSeconds`), so an idle PC holds no RAM or VRAM for it. If that server fails, the job falls back to `whisper-cli`.
- While someone records, the app streams the growing file and shows a live preview. It is a quick, greedy pass that yields to finished recordings; the text that counts always comes from the full upload. Preview audio is deleted when the upload arrives, after five idle minutes, or at the next service start.
- The phone gets its success only after the audio is on disk here; jobs survive a restart of the service.
- A failing transcription retries, then ends as failed with the audio kept. Sending retries for as long as T3 is unreachable.
- `t3 thread send` can only queue. To steer the running agent the app claims the job before it is transcribed and sends the message itself, so that case needs the app.
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

## Reachability

With `tunnelName` set, the service keeps an ssh tunnel open through the `devtunnel` host, so the phone reaches it from anywhere. The URL is public; the device token is what protects it. A leaked token lets its holder send messages to your threads, so treat it like a password.

## Tests

```sh
node --test test/*.test.ts
```
