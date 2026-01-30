const db = require('../db');

const upsertTask = db.prepare(`
  INSERT INTO tasks (id, title, status, assignee, priority, team, created_at, started_at, completed_at, source, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'linear', ?)
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, tasks.title),
    status = COALESCE(excluded.status, tasks.status),
    assignee = COALESCE(excluded.assignee, tasks.assignee),
    priority = COALESCE(excluded.priority, tasks.priority),
    team = COALESCE(excluded.team, tasks.team),
    started_at = COALESCE(excluded.started_at, tasks.started_at),
    completed_at = COALESCE(excluded.completed_at, tasks.completed_at),
    raw_data = excluded.raw_data
`);

// Map Linear state names to our normalized statuses
function normalizeStatus(stateName) {
  if (!stateName) return null;
  const lower = stateName.toLowerCase();
  if (['backlog', 'triage', 'unstarted'].includes(lower)) return 'backlog';
  if (['in progress', 'started', 'in review'].includes(lower)) return 'in_progress';
  if (['done', 'completed', 'merged'].includes(lower)) return 'done';
  if (['cancelled', 'canceled', 'duplicate'].includes(lower)) return 'cancelled';
  return lower;
}

function processIssue(payload) {
  const { action, data, type } = payload;

  // Linear sends { action, type, data, ... }
  // type is usually "Issue"
  if (type !== 'Issue' || !data) return null;

  const issue = data;
  const status = normalizeStatus(issue.state?.name);
  const identifier = issue.identifier || issue.id; // e.g. "ABC-123"

  // Determine started_at and completed_at from status
  let startedAt = null;
  let completedAt = null;

  if (status === 'in_progress' && (action === 'update' || action === 'create')) {
    startedAt = issue.updatedAt || issue.createdAt;
  }
  if (status === 'done') {
    completedAt = issue.completedAt || issue.updatedAt;
  }

  // If updating, preserve existing started_at — only set if transitioning to in_progress
  if (status === 'in_progress') {
    const existing = db.prepare('SELECT started_at FROM tasks WHERE id = ?').get(identifier);
    if (existing?.started_at) {
      startedAt = null; // don't overwrite
    }
  }

  upsertTask.run(
    identifier,
    issue.title || null,
    status,
    issue.assignee?.name || issue.assignee?.email || null,
    issue.priority ?? null,
    issue.team?.name || issue.team?.key || null,
    issue.createdAt || null,
    startedAt,
    completedAt,
    JSON.stringify(payload)
  );

  // Also link any existing sessions on a matching branch
  if (identifier) {
    db.prepare(`UPDATE sessions SET task_id = ? WHERE task_id IS NULL AND branch LIKE ?`)
      .run(identifier, `%${identifier}%`);
  }

  return { action, identifier, status };
}

module.exports = { processIssue, normalizeStatus };
