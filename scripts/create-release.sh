#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/create-release.sh <tag> [options]
  scripts/create-release.sh --bump <major|minor|patch> [options]

Description:
  Generates GitHub release notes from CHANGELOG.md using OpenAI,
  creates and pushes an annotated git tag, then creates a GitHub release.

Options:
  --bump <major|minor|patch> Auto-generate next stable semver tag (vX.Y.Z)
  --title <title>            Release title (default: <tag>)
  --target <git-ref>         Ref to tag (default: HEAD)
  --repo <owner/repo>        GitHub repository (default: current gh repo)
  --changelog <path>         Changelog path (default: CHANGELOG.md)
  --model <model>            OpenAI model (default: gpt-5.1-codex-mini)
  --draft                    Create release as draft
  --prerelease               Mark release as prerelease
  --dry-run                  Print generated release notes, skip tag/release creation
  -h, --help                 Show this help

Environment:
  OPENAI_API_KEY             Required for OpenAI note generation

Requires:
  git, gh, jq, curl
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
}

extract_latest_changelog_section() {
  local path="$1"
  awk '
    BEGIN { in_section = 0 }
    /^## / {
      if (in_section == 0) {
        in_section = 1
        print
        next
      }
      exit
    }
    {
      if (in_section == 1) print
    }
  ' "$path"
}

extract_response_content() {
  local response="$1"
  local content

  content=$(echo "$response" | jq -r '.output[]? | select(.type == "message") | .content[]? | select(.type == "output_text" or .type == "text") | .text // empty' | sed '/^$/d' || true)
  if [[ -z "$content" ]]; then
    content=$(echo "$response" | jq -r '.output_text // empty' || true)
  fi

  content=$(echo "$content" | sed -E 's/^```json[[:space:]]*//; s/^```[[:space:]]*//; s/[[:space:]]*```$//')
  printf "%s" "$content"
}

extract_changelog_entries_for_prs() {
  local changelog_path="$1"
  local pr_numbers="$2"

  if [[ -z "$pr_numbers" ]]; then
    return 0
  fi

  while IFS= read -r pr; do
    [[ -z "$pr" ]] && continue
    grep -E "\[#${pr}\]\(" "$changelog_path" || true
  done <<< "$pr_numbers" | awk '!seen[$0]++'
}

compute_next_tag() {
  local bump_kind="$1"
  local latest_stable
  local major=0
  local minor=0
  local patch=0

  latest_stable=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  if [[ -n "$latest_stable" ]]; then
    if [[ "$latest_stable" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
      major="${BASH_REMATCH[1]}"
      minor="${BASH_REMATCH[2]}"
      patch="${BASH_REMATCH[3]}"
    fi
  fi

  case "$bump_kind" in
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    patch)
      patch=$((patch + 1))
      ;;
    *)
      echo "Error: invalid bump kind: $bump_kind" >&2
      exit 1
      ;;
  esac

  printf "v%s.%s.%s" "$major" "$minor" "$patch"
}

TAG=""
BUMP_KIND=""
TITLE=""
TARGET="HEAD"
REPO=""
CHANGELOG_PATH="CHANGELOG.md"
MODEL="gpt-5.1-codex-mini"
DRAFT=false
PRERELEASE=false
DRY_RUN=false
OPENAI_MAX_RETRIES="${OPENAI_MAX_RETRIES:-3}"
OPENAI_BACKOFF_BASE_SECONDS="${OPENAI_BACKOFF_BASE_SECONDS:-2}"
OPENAI_MAX_OUTPUT_TOKENS="${OPENAI_MAX_OUTPUT_TOKENS:-2200}"
OPENAI_MAX_OUTPUT_TOKENS_CAP="${OPENAI_MAX_OUTPUT_TOKENS_CAP:-8000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump)
      BUMP_KIND="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --changelog)
      CHANGELOG_PATH="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --draft)
      DRAFT=true
      shift
      ;;
    --prerelease)
      PRERELEASE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Error: Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$TAG" ]]; then
        TAG="$1"
      else
        echo "Error: Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -n "$TAG" && -n "$BUMP_KIND" ]]; then
  echo "Error: provide either <tag> or --bump, not both" >&2
  usage
  exit 1
fi

if [[ -n "$BUMP_KIND" ]]; then
  if [[ "$BUMP_KIND" != "major" && "$BUMP_KIND" != "minor" && "$BUMP_KIND" != "patch" ]]; then
    echo "Error: --bump must be one of: major, minor, patch" >&2
    usage
    exit 1
  fi
  TAG=$(compute_next_tag "$BUMP_KIND")
  echo "Auto-generated tag from --bump $BUMP_KIND: $TAG" >&2
fi

if [[ -z "$TAG" ]]; then
  echo "Error: tag is required (or use --bump)" >&2
  usage
  exit 1
fi

if [[ -z "$TITLE" ]]; then
  TITLE="$TAG"
fi

for cmd in git gh jq curl; do
  require_cmd "$cmd"
done

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Error: OPENAI_API_KEY is required" >&2
  exit 1
fi

if [[ ! -f "$CHANGELOG_PATH" ]]; then
  echo "Error: changelog not found at $CHANGELOG_PATH" >&2
  exit 1
fi

if ! git rev-parse --verify "$TARGET^{commit}" >/dev/null 2>&1; then
  echo "Error: target ref '$TARGET' is not a valid commit" >&2
  exit 1
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Error: local tag already exists: $TAG" >&2
  exit 1
fi

if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  echo "Error: remote tag already exists on origin: $TAG" >&2
  exit 1
fi

LATEST_CHANGELOG_SECTION=$(extract_latest_changelog_section "$CHANGELOG_PATH")
if [[ -z "$LATEST_CHANGELOG_SECTION" ]]; then
  echo "Error: failed to parse latest section from $CHANGELOG_PATH" >&2
  exit 1
fi

CHANGELOG_PREVIEW=$(sed -n '1,260p' "$CHANGELOG_PATH")
PREVIOUS_TAG=$(git tag --sort=-version:refname | grep '^v' | head -n 1 || true)
COMPARE_URL=""
if [[ -n "$PREVIOUS_TAG" ]]; then
  COMPARE_URL="https://github.com/$REPO/compare/$PREVIOUS_TAG...$TAG"
fi

RANGE_SPEC="$TARGET"
if [[ -n "$PREVIOUS_TAG" ]]; then
  RANGE_SPEC="$PREVIOUS_TAG..$TARGET"
fi

COMMITS_IN_SCOPE=$(git log --no-merges --pretty=format:'- %h %s' "$RANGE_SPEC" | head -n 120 || true)
if [[ -z "$COMMITS_IN_SCOPE" ]]; then
  COMMITS_IN_SCOPE=$(git log --pretty=format:'- %h %s' "$TARGET" | head -n 20 || true)
fi

PR_NUMBERS_IN_SCOPE=$(git log --pretty=format:'%s%n%b' "$RANGE_SPEC" | grep -Eo '#[0-9]+' | tr -d '#' | awk '!seen[$0]++' || true)
CHANGELOG_ENTRIES_IN_SCOPE=$(extract_changelog_entries_for_prs "$CHANGELOG_PATH" "$PR_NUMBERS_IN_SCOPE")

read -r -d '' SYSTEM_PROMPT <<'EOF' || true
You are writing GitHub release notes for a software project.

Return JSON only in the format:
{
  "title": "...",
  "body": "..."
}

Rules:
- Body must be valid Markdown.
- Keep it concise, concrete, and release-ready.
- Use this source-priority order (highest to lowest):
  1) Commits in release scope
  2) Changelog entries matching release-scope PRs
  3) Latest changelog section (top-most/current section)
  4) Older broad context
- If sources conflict, keep only information from the higher-priority source.
- Never include items that cannot be traced to sources (1) or (2).
- Use this structure when possible:
  1) A short overview paragraph (1-2 sentences)
  2) "## Highlights" with grouped bullets from Added/Changed/Fixed
  3) "## Upgrade Notes" with operational implications (if any)
  4) "## Links" with compare URL only when provided
- Mention only changes present in the provided inputs.
- If a commit/changelog item is outside the release scope, do not include it.
- Prefer user-impact wording over implementation internals.
- Avoid repeating the same change in multiple bullets.
- Do not invent changes.
EOF

read -r -d '' USER_PROMPT <<EOF || true
Repository: $REPO
Release tag: $TAG
Requested title: $TITLE
Previous tag: ${PREVIOUS_TAG:-none}
Compare URL: ${COMPARE_URL:-none}
Release scope: ${RANGE_SPEC}

Latest changelog section:
$LATEST_CHANGELOG_SECTION

Commits in release scope:
$COMMITS_IN_SCOPE

PR numbers detected in release scope:
${PR_NUMBERS_IN_SCOPE:-none}

Changelog entries matching release-scope PRs:
${CHANGELOG_ENTRIES_IN_SCOPE:-none}

Known policy facts (must not be contradicted):
- latest image tag is updated only on version-tag pushes
- main branch pushes publish main and sha-* development tags
- release notes must describe only this release scope, not historical aggregate context

Return release notes that are polished for GitHub Releases and easy to scan.
Return a valid JSON object with keys "title" and "body".
If Compare URL is not "none", include it as a markdown link under "## Links".
If Compare URL is "none", do not include "## Links" or "## Full Changelog" sections.
Apply source-priority exactly as specified in the system prompt.
If "Changelog entries matching release-scope PRs" is not "none", prioritize those entries over broader changelog context.
EOF

RESPONSE=""
CONTENT=""
ATTEMPT=1
REQUEST_MAX_OUTPUT_TOKENS="$OPENAI_MAX_OUTPUT_TOKENS"
while [[ "$ATTEMPT" -le "$OPENAI_MAX_RETRIES" ]]; do
  PAYLOAD=$(jq -n \
    --arg model "$MODEL" \
    --arg system "$SYSTEM_PROMPT" \
    --arg user "$USER_PROMPT" \
    --argjson max_output_tokens "$REQUEST_MAX_OUTPUT_TOKENS" \
    '{
      model: $model,
      instructions: $system,
      input: $user,
      max_output_tokens: $max_output_tokens,
      text: { format: { type: "json_object" } }
    }')

  if ! RESPONSE=$(curl -sS -X POST "https://api.openai.com/v1/responses" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \
    -d "$PAYLOAD"); then
    echo "Attempt ${ATTEMPT}/${OPENAI_MAX_RETRIES}: failed to reach OpenAI API" >&2
  elif [[ "$(echo "$RESPONSE" | jq -r '.error.message // empty')" != "" ]]; then
    echo "Attempt ${ATTEMPT}/${OPENAI_MAX_RETRIES}: OpenAI API error: $(echo "$RESPONSE" | jq -r '.error.message // "unknown"')" >&2
  else
    INCOMPLETE_REASON=$(echo "$RESPONSE" | jq -r '.incomplete_details.reason // empty')
    if [[ "$INCOMPLETE_REASON" == "max_output_tokens" ]]; then
      NEXT_MAX=$((REQUEST_MAX_OUTPUT_TOKENS * 2))
      if [[ "$NEXT_MAX" -gt "$OPENAI_MAX_OUTPUT_TOKENS_CAP" ]]; then
        NEXT_MAX="$OPENAI_MAX_OUTPUT_TOKENS_CAP"
      fi
      if [[ "$NEXT_MAX" -gt "$REQUEST_MAX_OUTPUT_TOKENS" ]]; then
        echo "Attempt ${ATTEMPT}/${OPENAI_MAX_RETRIES}: response hit max_output_tokens (${REQUEST_MAX_OUTPUT_TOKENS}); next retry will use ${NEXT_MAX}" >&2
        REQUEST_MAX_OUTPUT_TOKENS="$NEXT_MAX"
      fi
    fi

    CONTENT=$(extract_response_content "$RESPONSE")
    if [[ -z "$CONTENT" || "$CONTENT" == "null" ]]; then
      echo "Attempt ${ATTEMPT}/${OPENAI_MAX_RETRIES}: empty response content from OpenAI" >&2
    elif ! echo "$CONTENT" | jq -e '.title and .body' >/dev/null 2>&1; then
      echo "Attempt ${ATTEMPT}/${OPENAI_MAX_RETRIES}: OpenAI response missing title/body JSON fields" >&2
      echo "$CONTENT" >&2
    else
      break
    fi
  fi

  if [[ "$ATTEMPT" -lt "$OPENAI_MAX_RETRIES" ]]; then
    BACKOFF_SECONDS=$((OPENAI_BACKOFF_BASE_SECONDS ** ATTEMPT))
    echo "Retrying in ${BACKOFF_SECONDS}s..." >&2
    sleep "$BACKOFF_SECONDS"
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

if [[ -z "$CONTENT" || "$CONTENT" == "null" ]]; then
  echo "Error: failed to generate release notes after ${OPENAI_MAX_RETRIES} attempts" >&2
  exit 1
fi

RELEASE_TITLE=$(echo "$CONTENT" | jq -r '.title')
RELEASE_BODY=$(echo "$CONTENT" | jq -r '.body')

if [[ -z "$COMPARE_URL" ]]; then
  RELEASE_BODY=$(printf "%s\n" "$RELEASE_BODY" | awk '
    BEGIN { skip = 0 }
    /^## (Links|Full Changelog)$/ { skip = 1; next }
    /^## / { skip = 0 }
    {
      if (skip == 1) next
      if ($0 ~ /https:\/\/github\.com\/.+\/compare\//) next
      print
    }
  ')
fi

if [[ -z "$RELEASE_TITLE" || "$RELEASE_TITLE" == "null" ]]; then
  RELEASE_TITLE="$TITLE"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] tag: $TAG"
  echo "[dry-run] target: $TARGET"
  echo "[dry-run] repo: $REPO"
  echo
  echo "Release title:"
  echo "$RELEASE_TITLE"
  echo
  echo "Release body:"
  echo "$RELEASE_BODY"
  exit 0
fi

echo "Creating and pushing tag $TAG at $TARGET..."
git tag -a "$TAG" "$TARGET" -m "Release $TAG"
git push origin "$TAG"

echo "Creating GitHub release $TAG..."
args=(release create "$TAG" --repo "$REPO" --title "$RELEASE_TITLE" --notes "$RELEASE_BODY")
if [[ "$DRAFT" == "true" ]]; then
  args+=(--draft)
fi
if [[ "$PRERELEASE" == "true" ]]; then
  args+=(--prerelease)
fi

gh "${args[@]}"
echo "Release created: $TAG"
