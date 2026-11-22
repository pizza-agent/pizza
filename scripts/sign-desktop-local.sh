#!/bin/bash
# Sign Pizza.app with a stable local self-signed identity.
#
# Why: on macOS, TCC attributes accessibility grants to the responsible app's
# code identity. Ad-hoc ("Signature=adhoc") builds resolve to a binary-hash
# identity that never matches the bundle grant the user makes in System
# Settings, so agent-desktop's AXIsProcessTrusted check returns denied and
# _desktop is dead. A stable certificate makes the identity ai.pizza.gui,
# which matches the grant and survives rebuilds (the requirement anchors to
# the certificate, not the binary hash).
#
# Not a substitute for Developer ID signing: Gatekeeper still warns on other
# machines. This is for local dev/QA only.
#
# Usage: bash scripts/sign-desktop-local.sh [path/to/Pizza.app]

set -euo pipefail

CERT_NAME="Pizza Local Signing"
APP="${1:-apps/desktop/target/release/bundle/macos/Pizza.app}"

if [ "$(uname)" != "Darwin" ]; then
	echo "sign-desktop-local: macOS only, skipping."
	exit 0
fi

if [ ! -d "$APP" ]; then
	echo "sign-desktop-local: app not found: $APP" >&2
	exit 1
fi

if ! security find-certificate -c "$CERT_NAME" >/dev/null 2>&1; then
	echo "sign-desktop-local: creating self-signed cert '$CERT_NAME' in login keychain"
	WORK="$(mktemp -d)"
	trap 'rm -rf "$WORK"' EXIT
	openssl req -x509 -newkey rsa:2048 \
		-keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
		-days 3650 -nodes -subj "/CN=$CERT_NAME" \
		-addext "extendedKeyUsage=codeSigning" \
		-addext "keyUsage=digitalSignature"
	# The legacy flag set produces a PKCS#12 macOS can import.
	openssl pkcs12 -export -out "$WORK/id.p12" \
		-inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
		-passout pass:pizza -legacy -macalg sha1 \
		-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
	security import "$WORK/id.p12" \
		-k "$HOME/Library/Keychains/login.keychain-db" \
		-P pizza -A >/dev/null
	echo "sign-desktop-local: cert imported. Grant Accessibility once; it stays valid for all builds signed with this cert."
fi

codesign --force --deep --sign "$CERT_NAME" --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
echo "sign-desktop-local: signed $APP as '$(codesign -dv "$APP" 2>&1 | awk -F= '/^Identifier/{print $2}')'"
