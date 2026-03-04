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

// --- AI Health Label Sync ---

const HEALTH_LABELS = {
  smooth:     { name: 'AI: Smooth',     color: '#4CAF50' },
  friction:   { name: 'AI: Friction',   color: '#FF9800' },
  struggling: { name: 'AI: Struggling', color: '#F44336' },
};

// Cache: teamId -> { smooth: labelId, friction: labelId, struggling: labelId }
const labelCache = new Map();

function computeHealthLevel(metrics) {
  const { error_rate, edit_success_rate, bash_retries, rework_index, total_tools } = metrics;

  // Need a minimum sample before penalising edit_success_rate —
  // a single failed edit on a fresh task shouldn't immediately flag struggling.
  const enoughEdits = total_tools >= 4;

  // Struggling: clear signal something is badly wrong
  if (error_rate > 0.3)                        return 'struggling';
  if (enoughEdits && edit_success_rate < 0.5)  return 'struggling';
  if (bash_retries >= 3)                       return 'struggling';
  if (rework_index > 0.5)                      return 'struggling';

  // Friction: elevated errors or repeated corrections
  if (error_rate >= 0.1)                       return 'friction';
  if (enoughEdits && edit_success_rate <= 0.8) return 'friction';
  if (bash_retries >= 1)                       return 'friction';
  if (rework_index > 0.2)                      return 'friction';

  return 'smooth';
}

async function linearGql(apiKey, query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Linear GQL: ${json.errors[0].message}`);
  return json.data;
}

async function ensureLabels(apiKey, teamId) {
  if (labelCache.has(teamId)) return labelCache.get(teamId);

  // Fetch existing labels on the team that start with "AI:"
  const existing = await linearGql(apiKey, `
    query($teamId: ID!) {
      issueLabels(filter: { team: { id: { eq: $teamId } }, name: { startsWith: "AI:" } }) {
        nodes { id name }
      }
    }
  `, { teamId });

  const ids = {};
  const existingByName = {};
  for (const label of existing.issueLabels.nodes) {
    existingByName[label.name] = label.id;
  }

  for (const [level, { name, color }] of Object.entries(HEALTH_LABELS)) {
    if (existingByName[name]) {
      ids[level] = existingByName[name];
    } else {
      const created = await linearGql(apiKey, `
        mutation($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { issueLabel { id } success }
        }
      `, { input: { name, color, teamId } });
      ids[level] = created.issueLabelCreate.issueLabel.id;
    }
  }

  labelCache.set(teamId, ids);
  return ids;
}

async function syncHealthLabel(apiKey, taskIdentifier, metrics) {
  if (!apiKey) return;

  const level = computeHealthLevel(metrics);

  // Look up issue by identifier
  const issueData = await linearGql(apiKey, `
    query($term: String!) {
      searchIssues(term: $term, first: 1) {
        nodes { id team { id } labels { nodes { id name } } }
      }
    }
  `, { term: taskIdentifier });

  const issue = issueData.searchIssues.nodes[0];
  if (!issue) return;

  const teamId = issue.team.id;
  const labelIds = await ensureLabels(apiKey, teamId);

  // Apply the correct label first, then remove stale AI: labels
  // (apply-before-remove ensures the label is never missing if something fails)
  await linearGql(apiKey, `
    mutation($issueId: String!, $labelId: String!) {
      issueAddLabel(id: $issueId, labelId: $labelId) { success }
    }
  `, { issueId: issue.id, labelId: labelIds[level] });

  const aiLabels = issue.labels.nodes.filter(l => l.name.startsWith('AI:') && l.id !== labelIds[level]);
  for (const label of aiLabels) {
    await linearGql(apiKey, `
      mutation($issueId: String!, $labelId: String!) {
        issueRemoveLabel(id: $issueId, labelId: $labelId) { success }
      }
    `, { issueId: issue.id, labelId: label.id });
  }

  console.log(`[LINEAR] Applied "${HEALTH_LABELS[level].name}" to ${taskIdentifier}`);
  return level;
}

// --- Cost Comment Sync ---

// In-memory state: taskIdentifier -> { commentId, lastBody }
const lastSyncState = new Map();

function formatTokenCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return null;
  if (minutes < 1) return '< 1m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function buildCostCommentBody(healthLevel, tokenUsage) {
  const healthTag = healthLevel ? ` | Health: ${HEALTH_LABELS[healthLevel]?.name || healthLevel}` : '';
  const outputLine = tokenUsage.est_output_tokens > 0
    ? `Output tokens: ~${formatTokenCount(tokenUsage.est_output_tokens)} (estimated)`
    : 'Output tokens: not tracked yet';

  const lines = [
    `Claude usage update — ${tokenUsage.session_count} session(s), ${tokenUsage.total_turns} turns${healthTag}`,
  ];

  const duration = formatDuration(tokenUsage.total_duration_minutes);
  if (duration) {
    lines.push(`Time spent: ~${duration} (across ${tokenUsage.session_count} session(s))`);
  }

  lines.push(
    `Input tokens: ~${formatTokenCount(tokenUsage.est_input_tokens)} (estimated)`,
    outputLine,
    `Est. cost: ~$${tokenUsage.est_cost_usd.toFixed(4)}`,
    'Token counts are approximations (chars/4). Costs based on published API rates.',
  );

  return lines.join('\n');
}

async function syncCostComment(apiKey, taskIdentifier, healthLevel, tokenUsage) {
  if (!apiKey || !tokenUsage || tokenUsage.total_turns === 0) return;

  const body = buildCostCommentBody(healthLevel, tokenUsage);

  // Check if comment body actually changed
  const prev = lastSyncState.get(taskIdentifier);
  if (prev && prev.lastBody === body) return; // no meaningful change

  // Look up issue ID
  const issueData = await linearGql(apiKey, `
    query($term: String!) {
      searchIssues(term: $term, first: 1) {
        nodes { id }
      }
    }
  `, { term: taskIdentifier });

  const issue = issueData.searchIssues.nodes[0];
  if (!issue) return;

  if (prev?.commentId) {
    // Update existing comment in-place
    await linearGql(apiKey, `
      mutation($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success }
      }
    `, { id: prev.commentId, input: { body } });
    lastSyncState.set(taskIdentifier, { commentId: prev.commentId, lastBody: body });
    console.log(`[LINEAR] Updated cost comment on ${taskIdentifier}`);
  } else {
    // Create new comment
    const result = await linearGql(apiKey, `
      mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id } success }
      }
    `, { input: { issueId: issue.id, body } });
    const commentId = result.commentCreate.comment.id;
    lastSyncState.set(taskIdentifier, { commentId, lastBody: body });
    console.log(`[LINEAR] Created cost comment on ${taskIdentifier}`);
  }
}

// --- Sprint Summary Sync ---

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function syncSprintSummary(apiKey, issueId) {
  const { getTaskTokenUsage } = require('./metrics');

  // Fetch all tasks that have at least one session in the past 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const tasks = db.prepare(`
    SELECT DISTINCT t.id, t.title, t.status, t.assignee, t.team
    FROM tasks t
    JOIN sessions s ON s.task_id = t.id
    WHERE s.started_at >= ?
    ORDER BY t.id
  `).all(cutoff);

  if (tasks.length === 0) {
    console.log('[SPRINT] No tasks with sessions found in last 30 days');
    return { tasks: 0 };
  }

  // Aggregate per-task metrics + health
  let totalCost = 0;
  let totalSessions = 0;
  let totalTurns = 0;
  let totalDurationMins = 0;
  let smoothCount = 0, frictionCount = 0, strugglingCount = 0;
  const smoothTasks = [], frictionTasks = [], strugglingTasks = [];
  const taskRows = [];

  for (const task of tasks) {
    const usage = getTaskTokenUsage(task.id);

    // Get aggregate metrics for this task across all its sessions
    const metricsRow = db.prepare(`
      SELECT
        AVG(sm.error_rate) as avg_error_rate,
        AVG(sm.edit_success_rate) as avg_edit_success_rate,
        AVG(sm.productivity_score) as avg_productivity_score,
        AVG(sm.rework_index) as avg_rework_index,
        SUM(sm.bash_retries) as total_bash_retries
      FROM session_metrics sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE s.task_id = ?
    `).get(task.id);

    const health = metricsRow && metricsRow.avg_error_rate != null
      ? computeHealthLevel({ error_rate: metricsRow.avg_error_rate, edit_success_rate: metricsRow.avg_edit_success_rate })
      : null;

    totalCost += usage.est_cost_usd;
    totalSessions += usage.session_count;
    totalTurns += usage.total_turns;
    totalDurationMins += usage.total_duration_minutes;

    if (health === 'smooth') { smoothCount++; smoothTasks.push(task.id); }
    else if (health === 'friction') { frictionCount++; frictionTasks.push(task.id); }
    else if (health === 'struggling') { strugglingCount++; strugglingTasks.push(task.id); }

    taskRows.push({ task, usage, health, metrics: metricsRow });
  }

  // Sort tasks by cost desc for the table
  taskRows.sort((a, b) => b.usage.est_cost_usd - a.usage.est_cost_usd);

  const now = new Date();
  const sprintStart = new Date(cutoff);
  const healthIcon = { smooth: '🟢', friction: '🟡', struggling: '🔴', null: '⚪' };

  const costTable = taskRows.map(({ task, usage, health }) => {
    const dur = formatDuration(usage.total_duration_minutes) || '—';
    const icon = healthIcon[health] || '⚪';
    return `| ${task.id} | ${task.title || '—'} | ${usage.session_count} | ~${dur} | $${usage.est_cost_usd.toFixed(3)} | ${icon} |`;
  }).join('\n');

  // Avg metrics across all tasks
  const avgErrorRate = taskRows.length > 0
    ? taskRows.reduce((s, r) => s + (r.metrics?.avg_error_rate || 0), 0) / taskRows.length : 0;
  const avgEditSuccess = taskRows.length > 0
    ? taskRows.reduce((s, r) => s + (r.metrics?.avg_edit_success_rate || 0), 0) / taskRows.length : 0;
  const avgRework = taskRows.length > 0
    ? taskRows.reduce((s, r) => s + (r.metrics?.avg_rework_index || 0), 0) / taskRows.length : 0;

  const mostReworkTask = taskRows
    .filter(r => r.metrics?.avg_rework_index > 0)
    .sort((a, b) => (b.metrics?.avg_rework_index || 0) - (a.metrics?.avg_rework_index || 0))[0];

  const insightLines = [];
  if (avgEditSuccess > 0) insightLines.push(`Avg edit success rate: **${Math.round(avgEditSuccess * 100)}%**`);
  if (avgErrorRate > 0) insightLines.push(`Avg error rate: **${Math.round(avgErrorRate * 100)}%**`);
  if (avgRework > 0) insightLines.push(`Avg rework index: **${(avgRework * 100).toFixed(0)}%** of edits are rewrites`);
  if (mostReworkTask) insightLines.push(`Most rework: **${mostReworkTask.task.id}** — ${mostReworkTask.task.title || ''}`);

  const body = [
    `🤖 **AI Agent Sprint Report** — *${formatDate(sprintStart.toISOString())} → ${formatDate(now.toISOString())}*`,
    '',
    '**Overview**',
    `- ${tasks.length} tasks · ${totalSessions} sessions · ~${formatDuration(totalDurationMins) || '—'} AI coding time · **$${totalCost.toFixed(2)} est. cost**`,
    '',
    '**Health Breakdown**',
    smoothTasks.length ? `🟢 Smooth (${smoothCount}): ${smoothTasks.join(', ')}` : '',
    frictionTasks.length ? `🟡 Friction (${frictionCount}): ${frictionTasks.join(', ')}` : '',
    strugglingTasks.length ? `🔴 Struggling (${strugglingCount}): ${strugglingTasks.join(', ')}` : '',
    '',
    '**Cost & Time by Task**',
    '| Task | Title | Sessions | Time | Est. Cost | Health |',
    '| --- | --- | --- | --- | --- | --- |',
    costTable,
    '',
    '**Team Insights**',
    ...insightLines.map(l => `- ${l}`),
    '',
    `*Updated ${now.toUTCString()} · Token counts estimated (chars/4) · Costs based on published API rates*`,
  ].filter(l => l !== null).join('\n');

  // Find the issue and upsert a comment
  const issueData = await linearGql(apiKey, `
    query($id: String!) { issue(id: $id) { id } }
  `, { id: issueId });

  if (!issueData?.issue) throw new Error(`Linear issue ${issueId} not found`);

  // Use a simple in-memory ref for the sprint comment ID
  if (!syncSprintSummary._commentId) {
    // Create new comment
    const result = await linearGql(apiKey, `
      mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id } success }
      }
    `, { input: { issueId, body } });
    syncSprintSummary._commentId = result.commentCreate.comment.id;
    console.log(`[SPRINT] Created sprint summary comment on issue ${issueId}`);
  } else {
    await linearGql(apiKey, `
      mutation($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success }
      }
    `, { id: syncSprintSummary._commentId, input: { body } });
    console.log(`[SPRINT] Updated sprint summary comment on issue ${issueId}`);
  }

  return {
    tasks: tasks.length,
    sessions: totalSessions,
    turns: totalTurns,
    est_cost_usd: Math.round(totalCost * 10000) / 10000,
    smooth: smoothCount,
    friction: frictionCount,
    struggling: strugglingCount,
  };
}

module.exports = { processIssue, normalizeStatus, computeHealthLevel, syncHealthLabel, syncCostComment, syncSprintSummary, linearGql };
