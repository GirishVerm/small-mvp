const express = require('express');
const db = require('../db');
const { extractTaskId } = require('../services/correlation');
const { estimateTokens, computeSessionMetrics, computeTaskMetrics, getTaskTokenUsage } = require('../services/metrics');
const { syncHealthLabel, syncCostComment, syncSprintSummary } = require('../services/linear');

const router = express.Router();

router.use(express.json());

// Prepared statements
const upsertSession = db.prepare(`
  INSERT INTO sessions (id, project_dir, branch, started_at, ended_at, task_id, model)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    ended_at = excluded.ended_at,
    branch = COALESCE(excluded.branch, sessions.branch),
    task_id = COALESCE(excluded.task_id, sessions.task_id),
    model = COALESCE(excluded.model, sessions.model)
`);

const insertToolEvent = db.prepare(`
  INSERT INTO tool_events (session_id, hook_type, tool_name, file_path, timestamp,
    input_summary, output_summary, input_chars, output_chars, est_input_tokens, est_output_tokens, task_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertWebhookLog = db.prepare(`
  INSERT INTO webhook_log (source, event_type, received_at, payload)
  VALUES (?, ?, ?, ?)
`);

// Find matching PreToolUse for duration calculation
const findPreToolUse = db.prepare(`
  SELECT timestamp FROM tool_events
  WHERE session_id = ? AND tool_name = ? AND hook_type = 'PreToolUse'
  ORDER BY id DESC LIMIT 1
`);

const updateDuration = db.prepare(`
  UPDATE tool_events SET duration_ms = ? WHERE id = ?
`);

// Conversation turn statements
const insertConversationTurn = db.prepare(`
  INSERT INTO conversation_turns (session_id, turn_number, timestamp, tool_count,
    est_input_tokens, est_output_tokens, stop_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getSessionTurnCount = db.prepare(`
  SELECT COALESCE(MAX(turn_number), 0) as last_turn FROM conversation_turns WHERE session_id = ?
`);

const updateSessionTurnCounters = db.prepare(`
  UPDATE sessions SET
    conversation_turns = ?,
    est_input_tokens = COALESCE(est_input_tokens, 0) + ?,
    est_output_tokens = COALESCE(est_output_tokens, 0) + ?
  WHERE id = ?
`);

// Count tool events since last turn for this session
const countToolsSinceLastTurn = db.prepare(`
  SELECT
    COUNT(*) as tool_count,
    COALESCE(SUM(input_chars), 0) as total_input_chars,
    COALESCE(SUM(output_chars), 0) as total_output_chars
  FROM tool_events
  WHERE session_id = ? AND hook_type = 'PostToolUse'
    AND timestamp > COALESCE(
      (SELECT MAX(timestamp) FROM conversation_turns WHERE session_id = ?),
      '1970-01-01'
    )
`);

router.post('/', (req, res) => {
  try {
    const {
      hook: hookType,
      session_id: sessionId,
      tool_name: toolName,
      file_path: filePath,
      project_dir: projectDir,
      branch,
      timestamp,
      input_summary: inputSummary,
      output_summary: outputSummary,
      input_chars: inputChars,
      output_chars: outputChars,
      model,
      stop_reason: stopReason,
      message,
    } = req.body;

    if (!sessionId || !hookType) {
      return res.status(400).json({ error: 'session_id and hook are required' });
    }

    const now = timestamp || new Date().toISOString();
    const taskId = extractTaskId(branch);

    // Upsert session
    upsertSession.run(sessionId, projectDir || null, branch || null, now, now, taskId, model || null);

    // Insert tool event (for PreToolUse and PostToolUse)
    if (hookType === 'PreToolUse' || hookType === 'PostToolUse') {
      const inChars = inputChars || 0;
      const outChars = outputChars || 0;
      const estIn = estimateTokens(inChars);
      const estOut = estimateTokens(outChars);

      const result = insertToolEvent.run(
        sessionId,
        hookType,
        toolName || 'unknown',
        filePath || null,
        now,
        inputSummary || null,
        outputSummary || message || null,
        inChars,
        outChars,
        estIn,
        estOut,
        taskId || null
      );

      // Calculate duration for PostToolUse
      if (hookType === 'PostToolUse' && toolName) {
        const pre = findPreToolUse.get(sessionId, toolName);
        if (pre) {
          const durationMs = new Date(now) - new Date(pre.timestamp);
          if (durationMs >= 0) {
            updateDuration.run(durationMs, result.lastInsertRowid);
          }
        }

        // Sync Linear every 5 PostToolUse events (real-time observability)
        const SYNC_EVERY_N_TOOLS = 2;
        const { total_post } = db.prepare(
          `SELECT COUNT(*) as total_post FROM tool_events WHERE task_id = ? AND hook_type = 'PostToolUse'`
        ).get(taskId || '');
        if (taskId && total_post % SYNC_EVERY_N_TOOLS === 0) {
          try {
            const metrics = computeTaskMetrics(taskId);
            if (process.env.LINEAR_API_KEY) {
              const apiKey = process.env.LINEAR_API_KEY;
              syncHealthLabel(apiKey, taskId, metrics)
                .then(healthLevel => {
                  const tokenUsage = getTaskTokenUsage(taskId);
                  return syncCostComment(apiKey, taskId, healthLevel, tokenUsage);
                })
                .catch(err => console.error('[LINEAR] Tool-sync error:', err.message));
            }
          } catch (e) { /* non-critical */ }
        }
      }
    }

    // Handle Stop hook: record a conversation turn
    if (hookType === 'Stop') {
      const { last_turn } = getSessionTurnCount.get(sessionId);
      const turnNumber = last_turn + 1;

      const sinceLastTurn = countToolsSinceLastTurn.get(sessionId, sessionId);
      const turnInputTokens = estimateTokens(sinceLastTurn.total_input_chars);
      const turnOutputTokens = estimateTokens(sinceLastTurn.total_output_chars);

      insertConversationTurn.run(
        sessionId, turnNumber, now,
        sinceLastTurn.tool_count,
        turnInputTokens, turnOutputTokens,
        stopReason || null
      );

      updateSessionTurnCounters.run(turnNumber, turnInputTokens, turnOutputTokens, sessionId);

      // Recompute quality metrics every 3 turns (and on first turn for fast feedback)
      if (taskId && (turnNumber === 1 || turnNumber % 2 === 0)) {
        try {
          const metrics = computeTaskMetrics(taskId);
          if (process.env.LINEAR_API_KEY) {
            const apiKey = process.env.LINEAR_API_KEY;
            syncHealthLabel(apiKey, taskId, metrics)
              .then(healthLevel => {
                const tokenUsage = getTaskTokenUsage(taskId);
                return syncCostComment(apiKey, taskId, healthLevel, tokenUsage);
              })
              .catch(err => console.error('[LINEAR] Sync error:', err.message));
          }
        } catch (e) { /* non-critical */ }
      }
    }

    // Log raw payload
    insertWebhookLog.run('claude_hook', hookType, now, JSON.stringify(req.body));

    console.log(`[HOOK] ${hookType} | ${toolName || stopReason || 'notification'} | session=${sessionId.slice(0, 8)} | branch=${branch || 'unknown'}`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[HOOK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET sessions from DB
router.get('/sessions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const rows = db.prepare(`
    SELECT s.*, COUNT(te.id) as tool_event_count
    FROM sessions s
    LEFT JOIN tool_events te ON te.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// GET tool events for a session
router.get('/sessions/:sessionId/events', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM tool_events WHERE session_id = ? ORDER BY timestamp ASC
  `).all(req.params.sessionId);
  res.json(rows);
});

// GET quality metrics for a session
router.get('/sessions/:sessionId/metrics', (req, res) => {
  const sessionId = req.params.sessionId;
  // Compute fresh metrics
  try {
    const metrics = computeSessionMetrics(sessionId);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET conversation turns for a session
router.get('/sessions/:sessionId/turns', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY turn_number ASC
  `).all(req.params.sessionId);
  res.json(rows);
});

// GET aggregate token usage
router.get('/metrics/tokens', (req, res) => {
  const { since, until } = req.query;
  let sql = `
    SELECT
      COUNT(DISTINCT s.id) as total_sessions,
      COALESCE(SUM(s.conversation_turns), 0) as total_turns,
      COALESCE(SUM(s.est_input_tokens), 0) as total_est_input_tokens,
      COALESCE(SUM(s.est_output_tokens), 0) as total_est_output_tokens,
      COALESCE(SUM(s.est_input_tokens), 0) + COALESCE(SUM(s.est_output_tokens), 0) as total_est_tokens
    FROM sessions s
    WHERE 1=1
  `;
  const params = [];
  if (since) { sql += ' AND s.started_at >= ?'; params.push(since); }
  if (until) { sql += ' AND s.started_at <= ?'; params.push(until); }

  const row = db.prepare(sql).get(...params);
  res.json(row);
});

// GET model usage breakdown
router.get('/metrics/models', (req, res) => {
  const rows = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*) as session_count,
      COALESCE(SUM(conversation_turns), 0) as total_turns,
      COALESCE(SUM(est_input_tokens), 0) as est_input_tokens,
      COALESCE(SUM(est_output_tokens), 0) as est_output_tokens,
      COALESCE(SUM(est_input_tokens), 0) + COALESCE(SUM(est_output_tokens), 0) as est_total_tokens
    FROM sessions
    GROUP BY COALESCE(model, 'unknown')
    ORDER BY session_count DESC
  `).all();
  res.json(rows);
});

// GET quality leaderboard across sessions
router.get('/metrics/quality', (req, res) => {
  const rows = db.prepare(`
    SELECT sm.*, s.project_dir, s.branch, s.model, s.conversation_turns
    FROM session_metrics sm
    JOIN sessions s ON s.id = sm.session_id
    ORDER BY sm.productivity_score DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// Manual / on-demand label sync
router.post('/sync-label/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'LINEAR_API_KEY not set' });

  try {
    const session = db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.task_id) return res.status(400).json({ error: 'Session has no linked task' });

    const metrics = computeSessionMetrics(sessionId);
    const healthLevel = await syncHealthLabel(apiKey, session.task_id, metrics);
    const tokenUsage = getTaskTokenUsage(session.task_id);
    await syncCostComment(apiKey, session.task_id, healthLevel, tokenUsage);
    res.json({ ok: true, task_id: session.task_id, metrics, tokenUsage });
  } catch (err) {
    console.error('[LINEAR] Manual sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET per-task token usage and estimated cost
router.get('/metrics/task/:taskId', (req, res) => {
  try {
    const tokenUsage = getTaskTokenUsage(req.params.taskId);
    res.json(tokenUsage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST sprint summary sync to Linear
router.post('/metrics/sprint-sync', async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  const issueId = process.env.LINEAR_SPRINT_ISSUE_ID;
  if (!apiKey) return res.status(400).json({ error: 'LINEAR_API_KEY not set' });
  if (!issueId) return res.status(400).json({ error: 'LINEAR_SPRINT_ISSUE_ID not set' });

  try {
    const result = await syncSprintSummary(apiKey, issueId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[SPRINT SYNC ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
