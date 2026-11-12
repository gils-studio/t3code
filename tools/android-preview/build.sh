#!/usr/bin/env bash
# Builds the preview Android app (com.t3tools.t3code.preview) from a ref of this fork.
# Linux only: Windows hits MAX_PATH in the React Native build.
# Usage: build.sh [ref]   (default main). The last line is "APK <path>".
set -euo pipefail

REF="${1:-main}"
REPO="${T3_APK_REPO:-https://github.com/gils-studio/t3code.git}"
WORK="${T3_APK_WORK:-$HOME/fleet/work/t3code-apk}"
OUT="${T3_APK_OUT:-$HOME/fleet/work/t3code-apk-out}"
# Signer of the installed app: Expo's prebuild debug keystore. Another signer forces an uninstall, which wipes app data.
EXPECTED_SIGNER=fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c

[ -f "$HOME/fleet/tools/env.sh" ] && . "$HOME/fleet/tools/env.sh"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-$HOME/Android/Sdk}"
# Gradle 8 with this React Native version needs JDK 17.
export JAVA_HOME="${T3_APK_JAVA_HOME:-$HOME/fleet-tools/jdk-17.0.21+9}"
# The Expo config is TypeScript that only Node 24 loads.
export PATH="$JAVA_HOME/bin:${T3_APK_NODE_BIN:-$HOME/fleet/tools/node24/bin}:$PATH"
export NODE_OPTIONS=--max-old-space-size=4096

if [ ! -d "$WORK/.git" ]; then
  git clone --filter=blob:none "$REPO" "$WORK"
fi
cd "$WORK"
git fetch --quiet origin "$REF"
git checkout --quiet --force --detach FETCH_HEAD
git clean -fdxq -e node_modules
COMMIT=$(git rev-parse --short HEAD)
git log -1 --format='BUILD %h %cI %s'
node -v

[ -f .env ] || cp .env.example .env
PNPM_PREFIX="$HOME/fleet/tools/pnpm12"
[ -x "$PNPM_PREFIX/bin/pnpm" ] || npm i -g --prefix "$PNPM_PREFIX" pnpm@12.14.0
export PATH="$PNPM_PREFIX/bin:$PATH"
pnpm install --frozen-lockfile --config.engine-strict=false

cd apps/mobile
APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android --no-install
cd android
APP_VARIANT=preview ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --max-workers=2 \
  -Dorg.gradle.jvmargs=-Xmx2560m \
  -Dkotlin.compiler.execution.strategy=in-process

APK=$(ls app/build/outputs/apk/release/*.apk | head -n 1)
APKSIGNER=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n 1)
SIGNER=$("$APKSIGNER" verify --print-certs "$APK" | sed -n 's/.*SHA-256 digest: //p' | head -n 1)
if [ "$SIGNER" != "$EXPECTED_SIGNER" ]; then
  echo "Signer $SIGNER is not the installed app's signer; refusing to ship this APK." >&2
  exit 1
fi

mkdir -p "$OUT"
DEST="$OUT/t3-preview-$COMMIT.apk"
cp "$APK" "$DEST"
echo "APK $DEST"
