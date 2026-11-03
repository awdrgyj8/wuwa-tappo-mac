#!/bin/bash
# Imports the maintainer's stable code signing certificate into a temporary keychain
# for one CI job. Signing every release with the same certificate keeps the app's
# designated requirement stable, so macOS keeps Input Monitoring and Keychain
# approvals across updates. Nothing here prints the certificate or its password.
set -Eeuo pipefail

: "${MACOS_SIGNING_CERTIFICATE:?MACOS_SIGNING_CERTIFICATE is required}"
: "${MACOS_SIGNING_CERTIFICATE_PASSWORD:?MACOS_SIGNING_CERTIFICATE_PASSWORD is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'Code signing certificates can only be imported on macOS.' >&2
  exit 1
fi

KEYCHAIN="$RUNNER_TEMP/wuwatappo-signing.keychain-db"
CERTIFICATE="$RUNNER_TEMP/wuwatappo-signing.p12"
PUBLIC_CERTIFICATE="$RUNNER_TEMP/wuwatappo-signing.pem"
KEYCHAIN_PASSWORD=$(openssl rand -hex 32)
trap 'rm -f "$CERTIFICATE" "$PUBLIC_CERTIFICATE"' EXIT

printf '%s' "$MACOS_SIGNING_CERTIFICATE" | tr -d '[:space:]' | base64 --decode > "$CERTIFICATE"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 900 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
if ! security import "$CERTIFICATE" -k "$KEYCHAIN" -f pkcs12 -P "$MACOS_SIGNING_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null; then
  printf '%s\n' '::error::Could not import MACOS_SIGNING_CERTIFICATE. Check that it is the base64 text of the exported .p12 and that the password secret matches.'
  exit 1
fi
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
EXISTING=()
while IFS= read -r keychain; do
  keychain="${keychain#"${keychain%%[![:space:]]*}"}"
  keychain="${keychain%\"}"
  EXISTING+=("${keychain#\"}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"

# A self-signed certificate is trusted for code signing only on this runner.
security find-certificate -a -p "$KEYCHAIN" > "$PUBLIC_CERTIFICATE"
# perl's alarm bounds the call in case the runner ever asks for interactive approval.
if ! perl -e 'alarm shift; exec @ARGV' 60 sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$KEYCHAIN" "$PUBLIC_CERTIFICATE"; then
  printf '%s\n' '::warning::Could not mark the signing certificate as trusted on this runner; codesign will still be attempted.'
fi

IDENTITY=$(security find-identity -p codesigning "$KEYCHAIN" | awk '/^ *[0-9]+\) [0-9A-F]+ / && length($2) == 40 { print $2; exit }')
if [ -z "$IDENTITY" ]; then
  printf '%s\n' '::error::MACOS_SIGNING_CERTIFICATE has no code signing identity. Export the certificate together with its private key, created with the Code Signing certificate type.'
  exit 1
fi
printf 'MACOS_SIGNING_IDENTITY=%s\n' "$IDENTITY" >> "$GITHUB_ENV"
printf 'MACOS_SIGNING_KEYCHAIN=%s\n' "$KEYCHAIN" >> "$GITHUB_ENV"
printf 'Imported code signing identity %s\n' "$IDENTITY"
