#!/usr/bin/env bash
set -eu

RUNTIME_ROOT="${1:-src-tauri/bin/ghostscript}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [[ -z "$IDENTITY" ]]; then
  echo "ERROR: APPLE_SIGNING_IDENTITY is not set." >&2
  echo "Example: export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'" >&2
  exit 1
fi

if [[ ! -d "$RUNTIME_ROOT" ]]; then
  echo "ERROR: Runtime root not found: $RUNTIME_ROOT" >&2
  exit 1
fi

TMP_LIST="$(mktemp)"
find "$RUNTIME_ROOT" -type f \( -name '*.dylib' -o -path '*/bin/gs' \) | sort > "$TMP_LIST"

if [[ ! -s "$TMP_LIST" ]]; then
  rm -f "$TMP_LIST"
  echo "ERROR: No Ghostscript Mach-O files found under $RUNTIME_ROOT" >&2
  exit 1
fi

while IFS= read -r file; do
  chmod u+w "$file"
  if [[ "$file" == */bin/gs ]]; then
    codesign --force --sign "$IDENTITY" --timestamp --options runtime "$file"
  else
    codesign --force --sign "$IDENTITY" --timestamp "$file"
  fi
done < "$TMP_LIST"

rm -f "$TMP_LIST"

echo "Signed Ghostscript runtime files with identity: $IDENTITY"
