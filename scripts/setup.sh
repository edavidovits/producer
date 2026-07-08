#!/bin/bash
# Producer setup for a new machine

set -e

CERT_NAME="Producer Dev"
REGENERATE_CERT=0

for arg in "$@"; do
  case "$arg" in
    --regenerate-cert)
      REGENERATE_CERT=1
      ;;
    -h|--help)
      echo "Usage: scripts/setup.sh [--regenerate-cert]"
      echo ""
      echo "Do not regenerate the signing certificate casually. macOS privacy"
      echo "grants are keyed to the certificate leaf hash, so a new certificate"
      echo "requires toggling Producer permissions off and on in System Settings."
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $arg" >&2
      echo "Usage: scripts/setup.sh [--regenerate-cert]" >&2
      exit 2
      ;;
  esac
done

echo "=== Producer Setup ==="

cert_exists() {
  security find-certificate -c "$CERT_NAME" >/dev/null 2>&1
}

valid_identity_exists() {
  security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$CERT_NAME\"" >/dev/null
}

print_cert_sha1() {
  security find-certificate -c "$CERT_NAME" -Z 2>/dev/null \
    | awk '/SHA-1 hash:/ { print $3; exit }'
}

create_cert() {
  echo "[...] Creating self-signed certificate '$CERT_NAME'..."
  CERT_TMP=$(mktemp -d)
  cat > "$CERT_TMP/cert.conf" << 'CERTEOF'
[req]
distinguished_name = req_dn
x509_extensions = v3_req
prompt = no
[req_dn]
CN = Producer Dev
[v3_req]
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
CERTEOF

  # Prefer Homebrew's OpenSSL 3 (needs -legacy for keychain-compatible pkcs12);
  # fall back to system openssl (LibreSSL already emits the legacy format).
  if [ -x /opt/homebrew/opt/openssl@3/bin/openssl ]; then
    OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
    LEGACY_FLAG=-legacy
  elif [ -x /usr/local/opt/openssl@3/bin/openssl ]; then
    OPENSSL=/usr/local/opt/openssl@3/bin/openssl
    LEGACY_FLAG=-legacy
  else
    OPENSSL=openssl
    LEGACY_FLAG=
  fi

  "$OPENSSL" req -x509 -newkey rsa:2048 \
    -keyout "$CERT_TMP/key.pem" -out "$CERT_TMP/cert.pem" \
    -days 3650 -nodes -config "$CERT_TMP/cert.conf" 2>/dev/null

  "$OPENSSL" pkcs12 -export \
    -out "$CERT_TMP/producer.p12" \
    -inkey "$CERT_TMP/key.pem" -in "$CERT_TMP/cert.pem" \
    -passout pass:producer $LEGACY_FLAG 2>/dev/null

  security import "$CERT_TMP/producer.p12" \
    -k ~/Library/Keychains/login.keychain-db \
    -P producer -T /usr/bin/codesign

  rm -rf "$CERT_TMP"
  LEAF_SHA1=$(print_cert_sha1)
  echo "[ok] Certificate created and imported"
  echo "[info] $CERT_NAME leaf SHA-1: ${LEAF_SHA1:-unknown}"
  echo "[info] macOS privacy grants are keyed to this leaf hash."
}

# 1. Create self-signed code signing certificate (persists in keychain)
if [ "$REGENERATE_CERT" -eq 1 ]; then
  if cert_exists; then
    echo "[warn] Regenerating '$CERT_NAME'. Existing macOS privacy grants for Producer will stop applying."
    security delete-certificate -c "$CERT_NAME" >/dev/null 2>&1 || true
  fi
  create_cert
elif valid_identity_exists; then
  LEAF_SHA1=$(print_cert_sha1)
  echo "[ok] Signing certificate '$CERT_NAME' is valid"
  echo "[info] $CERT_NAME leaf SHA-1: ${LEAF_SHA1:-unknown}"
else
  if cert_exists && [ "$REGENERATE_CERT" -ne 1 ]; then
    echo "[error] A '$CERT_NAME' certificate exists, but it is not a valid code signing identity." >&2
    echo "Do not regenerate it silently. macOS privacy grants are keyed to the certificate leaf hash." >&2
    echo "Fix the keychain identity, or rerun with --regenerate-cert and then re-grant Producer permissions in System Settings." >&2
    exit 1
  fi

  create_cert
fi

# 2. Install dependencies
echo "[...] Installing dependencies..."
npm install

# 3. Build and install
echo "[...] Building Producer.app..."
npm run build

echo ""
echo "=== Done! ==="
echo "Producer.app is installed in /Applications."
echo "Open it from Spotlight or run: open /Applications/Producer.app"
echo ""
echo "Prerequisites:"
echo "  - Claude Code CLI must be installed (npm install -g @anthropic-ai/claude-code)"
echo "  - Codex CLI must be installed and authenticated if you want to launch Codex tabs"
echo "  - You'll be prompted to pick a workspace folder on first launch"
