#!/bin/bash
# Producer -- one-command setup for a new machine
# Usage: curl the repo, run this script

set -e

echo "=== Producer Setup ==="

# 1. Create self-signed code signing certificate (persists in keychain)
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Producer Dev"; then
  echo "[ok] Signing certificate 'Producer Dev' already exists"
else
  echo "[...] Creating self-signed certificate 'Producer Dev'..."
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
  echo "[ok] Certificate created and imported"
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
