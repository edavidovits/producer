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
  TMPDIR=$(mktemp -d)
  cat > "$TMPDIR/cert.conf" << 'CERTEOF'
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

  openssl req -x509 -newkey rsa:2048 \
    -keyout "$TMPDIR/key.pem" -out "$TMPDIR/cert.pem" \
    -days 3650 -nodes -config "$TMPDIR/cert.conf" 2>/dev/null

  openssl pkcs12 -export \
    -out "$TMPDIR/producer.p12" \
    -inkey "$TMPDIR/key.pem" -in "$TMPDIR/cert.pem" \
    -passout pass:producer -legacy 2>/dev/null

  security import "$TMPDIR/producer.p12" \
    -k ~/Library/Keychains/login.keychain-db \
    -P producer -T /usr/bin/codesign

  rm -rf "$TMPDIR"
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
