@AGENTS.md

# Our fork (gils-studio/t3code)

AGENTS.md is upstream's (pingdotgg/t3code) and stays untouched. Where it conflicts with our house rules, these lines win:

- Lead: Gerrit. Main only: the fork runs on our PC and phones, nothing hosted.
- PRs into the fork are always wanted (house rules). No PRs to upstream unless asked; `gh` here defaults to upstream, so always pass `-R gils-studio/t3code`.
- Upstream's CI does not run here (GitHub Actions is off). `vp run check:changed` plus the tests of what you touched is the whole check; run it on pop-os with `PATH=$HOME/fleet/tools/node24/bin:$PATH` (the local checkout is sparse, and under Node 22 it exits 0 without checking anything).
- `~/.t3/userdata` is the live install every Claude session runs in; AGENTS.md's "writing to the live install" applies doubly.
- Android: ship merged mobile changes with `tools/android-preview/build.sh` (README there), then `fleet phone install` on both phones. Voice transcription service: `tools/voice-server`.
