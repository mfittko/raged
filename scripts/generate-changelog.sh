#!/usr/bin/env bash

set -euo pipefail

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required but not installed" >&2
    exit 1
  fi
done

CHANGELOG_PATH="${CHANGELOG_PATH:-CHANGELOG.md}"
MAX_PRS="${MAX_PRS:-1000}"

echo "Fetching closed pull requests..." >&2
PRS_JSON=$(gh pr list \
  --state closed \
  --limit "$MAX_PRS" \
  --json number,title,url,closedAt)

HEADER=$(cat <<'EOF'
# Changelog

All notable changes to this project are documented in this file.

The entries are backfilled from closed pull requests.

---
EOF
)

SECTIONS=$(echo "$PRS_JSON" | jq -r '
  def datefmt: (.closedAt | fromdateiso8601 | strftime("%B %d, %Y"));

  map(select(.closedAt != null))
  | sort_by(.closedAt, .number)
  | group_by(datefmt)
  | reverse
  | map(
      "## \(.[0] | datefmt)\n\n### Changed\n\n"
      + (
          sort_by(.number)
          | reverse
          | map("- **\(.title)** ([#\(.number)](\(.url)))")
          | join("\n")
        )
    )
  | join("\n\n")
')

TMP_FILE=$(mktemp)
{
  printf "%s\n" "$HEADER"
  if [[ -n "$SECTIONS" ]]; then
    printf "\n%s\n" "$SECTIONS"
  fi
} > "$TMP_FILE"

mv "$TMP_FILE" "$CHANGELOG_PATH"

COUNT=$(echo "$PRS_JSON" | jq 'length')
echo "Updated $CHANGELOG_PATH from ${COUNT} closed pull requests." >&2
