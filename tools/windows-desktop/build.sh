#!/usr/bin/env bash
# Builds the Windows x64 desktop installer from a ref of this fork, on a Windows fleet node.
# Usage: bash build.sh <ref> <path to t3-resource-monitor.exe>
set -euo pipefail
REF=${1:-main}
RESOURCE_MONITOR=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
WORK=${T3_DESKTOP_WORK:-/c/fleet/work/t3d}

if [ ! -d "$WORK/.git" ]; then
  git -c core.longpaths=true clone -q https://github.com/gils-studio/t3code.git "$WORK"
fi
cd "$WORK"
git config core.longpaths true
git fetch -q origin "$REF"
git checkout -q -f --detach FETCH_HEAD
git clean -qfdx -e node_modules -e native/resource-monitor/target
echo "commit $(git rev-parse --short HEAD)"

command -v vp >/dev/null || npm i -g vite-plus@1.4.0 >/dev/null
vp i

# No Rust toolchain on the nodes: reuse the resource monitor of an installed release.
RM_DIR=native/resource-monitor/target/x86_64-pc-windows-msvc/release
mkdir -p "$RM_DIR"
cp "$RESOURCE_MONITOR" "$RM_DIR/"
export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1
# Without an update repository the build has no update feed, so upstream releases never replace it.
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY
# T3 Connect's public config, as upstream's releases bake it in. Without it `t3 connect` and the
# relay are off, so the phones only reach the PC directly. Relay traces stay off.
export T3CODE_RELAY_URL=${T3CODE_RELAY_URL:-https://relay.t3.codes}
export T3CODE_CLERK_PUBLISHABLE_KEY=${T3CODE_CLERK_PUBLISHABLE_KEY:-pk_live_Y2xlcmsudDMuY29kZXMk}
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=${T3CODE_CLERK_CLI_OAUTH_CLIENT_ID:-hzxSgY2cH10sDU2r}
export T3CODE_CLERK_JWT_TEMPLATE=${T3CODE_CLERK_JWT_TEMPLATE:-t3-relay}

node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64
ls release/*.exe | sed 's/^/INSTALLER /'
