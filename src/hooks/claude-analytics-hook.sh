#!/usr/bin/env bash
# Claude Analytics Hook Script
# Usage: claude-analytics-hook.sh <hook_type>
# Called by Claude Code hooks with event data on stdin (JSON)
#
# Environment variables available from Claude Code:
#   CLAUDE_SESSION_ID - unique session identifier
#   CLAUDE_MODEL      - model being used (if set)

ANALYTICS_URL="${CLAUDE_ANALYTICS_URL:-http://localhost:3000}"
HOOK_TYPE="$1"

# Read the hook input from stdin
INPUT=$(cat)

# Extract tool name from the JSON input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // empty' 2>/dev/null)

# Capture full char counts before truncation
INPUT_RAW=$(echo "$INPUT" | jq -r '.tool_input | tostring' 2>/dev/null)
OUTPUT_RAW=$(echo "$INPUT" | jq -r '.tool_output // empty' 2>/dev/null)
INPUT_CHARS=${#INPUT_RAW}
OUTPUT_CHARS=${#OUTPUT_RAW}

# Truncate summaries for storage (2000 chars)
INPUT_SUMMARY=$(echo "$INPUT_RAW" | head -c 2000)
OUTPUT_SUMMARY=$(echo "$OUTPUT_RAW" | head -c 2000)

# Get git branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
PROJECT_DIR=$(pwd)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
MODEL="${CLAUDE_MODEL:-}"

# Build JSON payload
PAYLOAD=$(jq -n \
  --arg hook "$HOOK_TYPE" \
  --arg session_id "$SESSION_ID" \
  --arg tool_name "$TOOL_NAME" \
  --arg file_path "$FILE_PATH" \
  --arg project_dir "$PROJECT_DIR" \
  --arg branch "$BRANCH" \
  --arg timestamp "$TIMESTAMP" \
  --arg input_summary "$INPUT_SUMMARY" \
  --arg output_summary "$OUTPUT_SUMMARY" \
  --argjson input_chars "$INPUT_CHARS" \
  --argjson output_chars "$OUTPUT_CHARS" \
  --arg model "$MODEL" \
  --arg stop_reason "$STOP_REASON" \
  '{hook:$hook, session_id:$session_id, tool_name:$tool_name, file_path:$file_path, project_dir:$project_dir, branch:$branch, timestamp:$timestamp, input_summary:$input_summary, output_summary:$output_summary, input_chars:$input_chars, output_chars:$output_chars, model:$model, stop_reason:$stop_reason}')

# Send to analytics server (fire and forget, don't block Claude Code)
curl -s -X POST "${ANALYTICS_URL}/hooks/claude" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 2 > /dev/null 2>&1 &
