#!/bin/bash
set -euo pipefail

CERT_NAME="Producer Dev"
BUILT_APP="dist/mac-arm64/Producer.app"
INSTALLED_APP="/Applications/Producer.app"

usage() {
  echo "Usage: scripts/check-signing.sh prebuild|postbuild" >&2
  exit 2
}

identity_valid() {
  security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$CERT_NAME\"" >/dev/null
}

designated_requirement_hash() {
  local app_path="$1"
  codesign -d -r- "$app_path" 2>&1 | sed -n 's/.*certificate leaf = H"\([A-Fa-f0-9]*\)".*/\1/p' | head -n 1
}

phase="${1:-}"
case "$phase" in
  prebuild)
    if ! identity_valid; then
      echo "[error] Code signing identity '$CERT_NAME' is not valid." >&2
      echo "Run scripts/setup.sh only after resolving the keychain identity." >&2
      echo "Do not silently regenerate this certificate, because macOS TCC grants are keyed to the certificate leaf hash." >&2
      exit 1
    fi
    echo "[ok] Signing identity '$CERT_NAME' is valid"
    ;;
  postbuild)
    if [ ! -d "$BUILT_APP" ]; then
      echo "[error] Built app not found at $BUILT_APP" >&2
      exit 1
    fi
    if [ ! -d "$INSTALLED_APP" ]; then
      echo "[ok] No installed Producer.app found, skipping TCC signature comparison"
      exit 0
    fi

    built_hash="$(designated_requirement_hash "$BUILT_APP")"
    installed_hash="$(designated_requirement_hash "$INSTALLED_APP")"
    if [ -z "$built_hash" ] || [ -z "$installed_hash" ]; then
      echo "[error] Could not read designated requirement leaf hash for signing check." >&2
      echo "Built hash: ${built_hash:-missing}" >&2
      echo "Installed hash: ${installed_hash:-missing}" >&2
      exit 1
    fi
    if [ "$built_hash" != "$installed_hash" ]; then
      echo "[error] Built Producer.app has a different signing leaf hash than /Applications/Producer.app." >&2
      echo "Installed: $installed_hash" >&2
      echo "Built:     $built_hash" >&2
      echo "Installing this build would break existing macOS privacy grants for com.eytan.producer." >&2
      echo "Delete the old certificate intentionally, rebuild, then re-grant permissions in System Settings." >&2
      exit 1
    fi
    echo "[ok] Built app signing hash matches installed app"
    ;;
  *)
    usage
    ;;
esac
