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
 * Covers: bash/shell, Claude Code native tools (Read/Glob/Grep/Edit),
 * Node.js, Python, build tools, test runners, git, and network errors.
 */
const ERROR_PATTERNS = [
  // Generic error markers
  /\berror:/i,              // "Error:", "SyntaxError:", "TypeError:", "npm error:"
  /\berrors? found\b/i,     // "2 errors found", "errors found"
  /failed to\b/i,           // "failed to compile", "failed to read"
  /\bfailed\b/i,            // "build failed", "tests failed", "FAILED"
  /fatal:/i,                // git "fatal:", clang "fatal error:"

  // Exceptions & stack traces
  /\bexception\b/i,
  /traceback/i,
  /stack trace/i,

  // File system — bash, Node.js, AND Claude Code native tools
  /ENOENT/,
  /EACCES/,
  /EPERM/,
  /no such file/i,
  /file not found/i,
  /does not exist/i,        // Read: "File does not exist", Grep: "Path does not exist"
  /no files found/i,        // Glob: "No files found"
  /permission denied/i,
  /cannot read/i,
  /unable to read/i,
  /could not open/i,

  // Shell / process errors
  /command not found/i,
  /command failed/i,
  /not a command/i,
  /exit code [1-9]/i,
  /exited with (code|status) [1-9]/i,
  /killed/i,                // process killed / OOM

  // Network errors
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /connection refused/i,
  /connection timed out/i,
  /network error/i,
  /socket hang up/i,

  // Python errors
  /AttributeError/,
  /TypeError/,
  /ValueError/,
  /ImportError/,
  /ModuleNotFoundError/,
  /KeyError/,
  /IndexError/,
  /NameError/,
  /RuntimeError/,
  /OSError/,
  /IOError/,
  /ZeroDivisionError/,

  // JavaScript / Node.js errors
  /ReferenceError/,
  /RangeError/,
  /SyntaxError/,
  /Cannot find module/i,
  /\bis not defined\b/i,    // "x is not defined"
  /\bis not a function\b/i, // "x is not a function"
  /\bcannot read propert/i, // "Cannot read properties of undefined"
  /unexpected token/i,

  // Build / compile errors
  /build failed/i,
  /compilation (failed|error)/i,
  /cannot compile/i,
  /linker error/i,

  // Test runners (Jest, pytest, mocha, etc.)
  /\d+ (test|spec)s? failed/i,  // "3 tests failed"
  /test suite failed/i,
  /assertion.*failed/i,
  /AssertionError/,
  /FAIL\s/,                 // Jest: "FAIL src/foo.test.js"
  /passing.*failing/i,      // Mocha: "5 passing, 2 failing"

  // Package / dependency errors
  /not found/i,             // "module not found", "command not found", "package not found"
  /unresolved import/i,
  /missing (dependency|peer)/i,
  /peer dep/i,

  // Git errors
  /merge conflict/i,
  /\bCONFLICT\b/,
  /rejected/i,              // "push rejected"
  /cannot merge/i,
  /\bdetached HEAD\b/i,

  // Linters / type checkers
  /\d+ error[s,]/i,          // "5 errors," from eslint / tsc
  /type error/i,
  /\bwarning.*error\b/i,    // warnings escalated to errors
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
    files_touched, tool_diversity, rework_index, bash_retries, avg_tool_duration_ms, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    rework_index = excluded.rework_index,
    bash_retries = excluded.bash_retries,
    avg_tool_duration_ms = excluded.avg_tool_duration_ms,
    updated_at = excluded.updated_at
`);

function computeSessionMetrics(sessionId) {
  const events = db.prepare(`
    SELECT tool_name, output_summary, hook_type, file_path, duration_ms
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

  // For rework_index: track edit count per file
  const editsByFile = {};
  // For bash_retries: count consecutive bash failures
  let bashRetries = 0;
  let prevBashWasError = false;
  // For avg_tool_duration_ms
  let durationSum = 0;
  let durationCount = 0;

  for (const ev of events) {
    toolsSet.add(ev.tool_name);
    if (ev.file_path) filesSet.add(ev.file_path);
    if (isToolError(ev.output_summary)) totalErrors++;

    const editResult = isEditSuccess(ev.tool_name, ev.output_summary);
    if (editResult !== null) {
      totalEdits++;
      if (editResult) successfulEdits++;
      if (ev.file_path) {
        editsByFile[ev.file_path] = (editsByFile[ev.file_path] || 0) + 1;
      }
    }

    if (ev.tool_name === 'Bash') {
      const isError = isToolError(ev.output_summary);
      if (prevBashWasError && isError) bashRetries++;
      prevBashWasError = isError;
    } else {
      prevBashWasError = false;
    }

    if (ev.duration_ms != null && ev.duration_ms >= 0) {
      durationSum += ev.duration_ms;
      durationCount++;
    }
  }

  const errorRate = totalTools > 0 ? totalErrors / totalTools : 0;
  const editSuccessRate = totalEdits > 0 ? successfulEdits / totalEdits : 0;
  const turns = (session && session.conversation_turns) || 1;
  const productivityScore = totalTools / turns;

  // rework_index: fraction of edits that are rewrites (0 = no rework, 1 = every edit is a rewrite)
  const totalFileEdits = Object.values(editsByFile).reduce((a, b) => a + b, 0);
  const uniqueFilesEdited = Object.keys(editsByFile).length;
  const reworkIndex = totalFileEdits > 0
    ? (totalFileEdits - uniqueFilesEdited) / totalFileEdits
    : 0;

  const avgToolDurationMs = durationCount > 0 ? durationSum / durationCount : 0;

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
    Math.round(reworkIndex * 1000) / 1000,
    bashRetries,
    Math.round(avgToolDurationMs),
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
    rework_index: Math.round(reworkIndex * 1000) / 1000,
    bash_retries: bashRetries,
    avg_tool_duration_ms: Math.round(avgToolDurationMs),
  };
}

// --- Model Pricing (per token) ---

const MODEL_PRICING = {
  'opus-4.5':  { input: 15.00 / 1e6, output: 75.00 / 1e6 },
  'opus-4':    { input: 15.00 / 1e6, output: 75.00 / 1e6 },
  'sonnet-4':  { input:  3.00 / 1e6, output: 15.00 / 1e6 },
  'sonnet-3':  { input:  3.00 / 1e6, output: 15.00 / 1e6 },
  'haiku':     { input:  0.80 / 1e6, output:  4.00 / 1e6 },
};

const DEFAULT_PRICING = MODEL_PRICING['sonnet-4'];

function matchModelPricing(modelId) {
  if (!modelId) return DEFAULT_PRICING;
  const lower = modelId.toLowerCase();
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(prefix)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Get aggregated token usage for a task across all its sessions, grouped by model.
 */
function getTaskTokenUsage(taskId) {
  const rows = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*) as session_count,
      COALESCE(SUM(conversation_turns), 0) as total_turns,
      COALESCE(SUM(est_input_tokens), 0) as est_input_tokens,
      COALESCE(SUM(est_output_tokens), 0) as est_output_tokens
    FROM sessions
    WHERE task_id = ?
    GROUP BY COALESCE(model, 'unknown')
  `).all(taskId);

  let sessionCount = 0;
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  const modelBreakdown = [];

  for (const row of rows) {
    const pricing = matchModelPricing(row.model);
    const cost = row.est_input_tokens * pricing.input + row.est_output_tokens * pricing.output;

    sessionCount += row.session_count;
    totalTurns += row.total_turns;
    totalInputTokens += row.est_input_tokens;
    totalOutputTokens += row.est_output_tokens;
    totalCost += cost;

    modelBreakdown.push({
      model: row.model,
      session_count: row.session_count,
      total_turns: row.total_turns,
      est_input_tokens: row.est_input_tokens,
      est_output_tokens: row.est_output_tokens,
      est_cost_usd: Math.round(cost * 10000) / 10000,
    });
  }

  // Time aggregation across all sessions for this task
  const timeRow = db.prepare(`
    SELECT
      COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 1440), 0) as total_duration_minutes,
      MIN(started_at) as earliest_start,
      MAX(ended_at) as latest_end
    FROM sessions
    WHERE task_id = ? AND started_at IS NOT NULL AND ended_at IS NOT NULL
  `).get(taskId);

  return {
    session_count: sessionCount,
    total_turns: totalTurns,
    total_duration_minutes: Math.round((timeRow?.total_duration_minutes || 0) * 100) / 100,
    earliest_start: timeRow?.earliest_start || null,
    latest_end: timeRow?.latest_end || null,
    est_input_tokens: totalInputTokens,
    est_output_tokens: totalOutputTokens,
    est_cost_usd: Math.round(totalCost * 10000) / 10000,
    model_breakdown: modelBreakdown,
  };
}

/**
 * Compute quality metrics for a task across all its tool events (any session).
 * This is the correct unit for health labels — scoped to the issue, not the session.
 */
function computeTaskMetrics(taskId) {
  const events = db.prepare(`
    SELECT tool_name, output_summary, hook_type, file_path, duration_ms
    FROM tool_events WHERE task_id = ? AND hook_type = 'PostToolUse'
  `).all(taskId);

  const turns = db.prepare(`
    SELECT COALESCE(SUM(s.conversation_turns), 0) as total_turns
    FROM sessions s WHERE s.task_id = ?
  `).get(taskId)?.total_turns || 1;

  const totalTools = events.length;
  let totalErrors = 0, totalEdits = 0, successfulEdits = 0;
  const filesSet = new Set(), toolsSet = new Set();
  const editsByFile = {};
  let bashRetries = 0, prevBashWasError = false;
  let durationSum = 0, durationCount = 0;

  for (const ev of events) {
    toolsSet.add(ev.tool_name);
    if (ev.file_path) filesSet.add(ev.file_path);
    if (isToolError(ev.output_summary)) totalErrors++;

    const editResult = isEditSuccess(ev.tool_name, ev.output_summary);
    if (editResult !== null) {
      totalEdits++;
      if (editResult) successfulEdits++;
      if (ev.file_path) editsByFile[ev.file_path] = (editsByFile[ev.file_path] || 0) + 1;
    }

    if (ev.tool_name === 'Bash') {
      const isError = isToolError(ev.output_summary);
      if (prevBashWasError && isError) bashRetries++;
      prevBashWasError = isError;
    } else {
      prevBashWasError = false;
    }

    if (ev.duration_ms != null && ev.duration_ms >= 0) {
      durationSum += ev.duration_ms;
      durationCount++;
    }
  }

  const errorRate = totalTools > 0 ? totalErrors / totalTools : 0;
  const editSuccessRate = totalEdits > 0 ? successfulEdits / totalEdits : 0;
  const productivityScore = totalTools / turns;
  const totalFileEdits = Object.values(editsByFile).reduce((a, b) => a + b, 0);
  const uniqueFilesEdited = Object.keys(editsByFile).length;
  const reworkIndex = totalFileEdits > 0 ? (totalFileEdits - uniqueFilesEdited) / totalFileEdits : 0;
  const avgToolDurationMs = durationCount > 0 ? durationSum / durationCount : 0;

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
    rework_index: Math.round(reworkIndex * 1000) / 1000,
    bash_retries: bashRetries,
    avg_tool_duration_ms: Math.round(avgToolDurationMs),
  };
}

module.exports = { estimateTokens, isToolError, isEditSuccess, computeSessionMetrics, computeTaskMetrics, matchModelPricing, getTaskTokenUsage };
