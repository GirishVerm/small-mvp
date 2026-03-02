#!/usr/bin/env bash
# Claude Analytics Hook Script
# Called by Claude Code hooks with event data on stdin (JSON)
#
# JSON fields available on stdin:
#   session_id, cwd, hook_event_name, tool_name, tool_input, tool_response (PostToolUse)
#
# Environment variables from Claude Code:
#   CLAUDE_PROJECT_DIR - project root directory

ANALYTICS_URL="${CLAUDE_ANALYTICS_URL:-https://claude-analytics-1094547143237.us-central1.run.app}"
HOOK_TYPE="$1"

# Read the hook input from stdin
INPUT=$(cat)

# Extract session_id from JSON (not from env var)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)

# Extract tool name from the JSON input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)

# For Stop events
STOP_REASON=$(echo "$INPUT" | jq -r '.stop_hook_active // empty' 2>/dev/null)

# Capture full char counts before truncation
INPUT_RAW=$(echo "$INPUT" | jq -r '(.tool_input // "") | tostring' 2>/dev/null)
OUTPUT_RAW=$(echo "$INPUT" | jq -r '(.tool_response // "") | tostring' 2>/dev/null)
INPUT_CHARS=${#INPUT_RAW}
OUTPUT_CHARS=${#OUTPUT_RAW}

# Truncate summaries for storage (2000 chars)
INPUT_SUMMARY=$(echo "$INPUT_RAW" | head -c 2000)
OUTPUT_SUMMARY=$(echo "$OUTPUT_RAW" | head -c 2000)

# Get git branch and project info
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Model is not directly available as env var; extract from transcript if needed
MODEL=""

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
