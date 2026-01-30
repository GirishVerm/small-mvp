const db = require('../db');

/**
 * Estimate token count from character count.
 * Heuristic: ~4 characters per token for English text/code.
 */
function estimateTokens(charCount) {
  if (!charCount || charCount <= 0) return 0;
  return Math.ceil(charCount / 4);
}

/**
 * Detect if tool output indicates an error.
 */
const ERROR_PATTERNS = [
  /error:/i,
  /failed to/i,
  /exception/i,
  /traceback/i,
  /ENOENT/,
  /EACCES/,
  /permission denied/i,
  /command failed/i,
  /exit code [1-9]/i,
  /no such file/i,
  /not found/i,
  /syntax error/i,
];

function isToolError(output) {
  if (!output) return false;
  return ERROR_PATTERNS.some(p => p.test(output));
}

/**
 * Detect if an edit tool call succeeded.
 */
function isEditSuccess(toolName, output) {
  if (!toolName || !output) return null; // not an edit
  const editTools = ['Edit', 'Write', 'NotebookEdit'];
  if (!editTools.includes(toolName)) return null;
  if (isToolError(output)) return false;
  if (/updated successfully/i.test(output) || /written/i.test(output)) return true;
  // If no error detected, assume success
  return !isToolError(output);
}

/**
 * Compute and upsert quality metrics for a session.
 */
const upsertSessionMetrics = db.prepare(`
  INSERT INTO session_metrics (session_id, total_tools, total_errors, error_rate,
    total_edits, successful_edits, edit_success_rate, productivity_score,
    files_touched, tool_diversity, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    total_tools = excluded.total_tools,
    total_errors = excluded.total_errors,
    error_rate = excluded.error_rate,
    total_edits = excluded.total_edits,
    successful_edits = excluded.successful_edits,
    edit_success_rate = excluded.edit_success_rate,
    productivity_score = excluded.productivity_score,
    files_touched = excluded.files_touched,
    tool_diversity = excluded.tool_diversity,
    updated_at = excluded.updated_at
`);

function computeSessionMetrics(sessionId) {
  const events = db.prepare(`
    SELECT tool_name, output_summary, hook_type, file_path
    FROM tool_events WHERE session_id = ? AND hook_type = 'PostToolUse'
  `).all(sessionId);

  const session = db.prepare(`
    SELECT conversation_turns FROM sessions WHERE id = ?
  `).get(sessionId);

  const totalTools = events.length;
  let totalErrors = 0;
  let totalEdits = 0;
  let successfulEdits = 0;
  const filesSet = new Set();
  const toolsSet = new Set();

  for (const ev of events) {
    toolsSet.add(ev.tool_name);
    if (ev.file_path) filesSet.add(ev.file_path);
    if (isToolError(ev.output_summary)) totalErrors++;

    const editResult = isEditSuccess(ev.tool_name, ev.output_summary);
    if (editResult !== null) {
      totalEdits++;
      if (editResult) successfulEdits++;
    }
  }

  const errorRate = totalTools > 0 ? totalErrors / totalTools : 0;
  const editSuccessRate = totalEdits > 0 ? successfulEdits / totalEdits : 0;
  const turns = (session && session.conversation_turns) || 1;
  const productivityScore = totalTools / turns;

  upsertSessionMetrics.run(
    sessionId,
    totalTools,
    totalErrors,
    Math.round(errorRate * 1000) / 1000,
    totalEdits,
    successfulEdits,
    Math.round(editSuccessRate * 1000) / 1000,
    Math.round(productivityScore * 100) / 100,
    filesSet.size,
    toolsSet.size,
    new Date().toISOString()
  );

  return {
    total_tools: totalTools,
    total_errors: totalErrors,
    error_rate: Math.round(errorRate * 1000) / 1000,
    total_edits: totalEdits,
    successful_edits: successfulEdits,
    edit_success_rate: Math.round(editSuccessRate * 1000) / 1000,
    productivity_score: Math.round(productivityScore * 100) / 100,
    files_touched: filesSet.size,
    tool_diversity: toolsSet.size,
  };
}

module.exports = { estimateTokens, isToolError, isEditSuccess, computeSessionMetrics };
