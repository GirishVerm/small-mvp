#!/usr/bin/env node
/**
 * Seed realistic demo data for the dev meetup.
 *
 * Story: A 3-person engineering team (Girish, Alex, Maya) at a fintech startup
 * adopting AI coding agents over a 2-week sprint.
 *
 * Usage:
 *   node scripts/seed-demo.js          # seed data (safe to re-run)
 *   node scripts/seed-demo.js --clean  # wipe seeded data first
 */

const path = require('path');
process.env.ANALYTICS_DB_PATH = path.join(__dirname, '../data/analytics.db');

const db = require('../src/db');
const { computeSessionMetrics } = require('../src/services/metrics');

const CLEAN = process.argv.includes('--clean');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n, offsetMinutes = 0) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000 + offsetMinutes * 60 * 1000).toISOString();
}

function minutesAfter(iso, mins) {
  return new Date(new Date(iso).getTime() + mins * 60 * 1000).toISOString();
}

function uuid() {
  return 'seed-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Project file paths (realistic for a payments SaaS)
// ---------------------------------------------------------------------------

const FILES = {
  payments: [
    'src/payments/stripe.js',
    'src/payments/webhooks.js',
    'src/payments/validators.js',
    'src/payments/retry.js',
    'tests/payments/stripe.test.js',
  ],
  auth: [
    'src/auth/middleware.js',
    'src/auth/tokens.js',
    'src/auth/session.js',
    'tests/auth/middleware.test.js',
  ],
  subscriptions: [
    'src/models/subscription.js',
    'src/api/routes/subscriptions.js',
    'src/services/billing.js',
    'src/jobs/renewal.js',
    'tests/subscriptions/billing.test.js',
  ],
  dashboard: [
    'src/api/routes/merchants.js',
    'src/dashboard/charts.js',
    'src/dashboard/filters.js',
    'src/components/MetricCard.jsx',
    'src/components/TransactionTable.jsx',
  ],
  export: [
    'src/exports/csv.js',
    'src/exports/formatters.js',
    'src/api/routes/exports.js',
    'tests/exports/csv.test.js',
  ],
  database: [
    'src/config/database.js',
    'migrations/001_initial.sql',
    'migrations/002_subscriptions.sql',
    'src/models/index.js',
    'src/utils/query-builder.js',
  ],
};

// ---------------------------------------------------------------------------
// Tool event generation
// ---------------------------------------------------------------------------

const EXPLORATION_TOOLS = ['Read', 'Glob', 'Grep', 'Read', 'Read', 'Glob'];
const EDIT_TOOLS = ['Edit', 'Write', 'Edit', 'Edit', 'Write', 'NotebookEdit'];
const BASH_TOOLS = ['Bash'];

function makeToolEvent(sessionId, toolName, filePath, timestamp, durationMs, opts = {}) {
  const isEdit = ['Edit', 'Write', 'NotebookEdit'].includes(toolName);
  const isBash = toolName === 'Bash';

  let inputSummary, outputSummary, inputChars, outputChars;

  if (isEdit) {
    inputSummary = `file_path: ${filePath}, old_string: "...", new_string: "..."`;
    const success = opts.forceError ? false : (Math.random() > (opts.errorRate || 0.1));
    outputSummary = success ? 'File updated successfully.' : `Error: EACCES: permission denied, open '${filePath}'`;
    inputChars = 800 + Math.floor(Math.random() * 3200);
    outputChars = success ? 40 : 60;
  } else if (isBash) {
    const cmd = opts.bashCmd || 'npm test';
    inputSummary = `command: ${cmd}`;
    const success = opts.forceError ? false : (Math.random() > (opts.errorRate || 0.15));
    outputSummary = success
      ? `> ${cmd}\n\n  ✓ ${Math.floor(Math.random() * 20) + 5} tests passed\n\nDone in ${(Math.random() * 3 + 0.5).toFixed(1)}s`
      : `> ${cmd}\n\n  ✗ Test failed: expected undefined to equal "active"\n  exit code 1`;
    inputChars = cmd.length + 20;
    outputChars = outputSummary.length;
  } else {
    // Read, Glob, Grep
    inputSummary = toolName === 'Read' ? `file_path: ${filePath}` : `pattern: "*.js", path: "src/"`;
    outputSummary = toolName === 'Read'
      ? `// ${filePath}\n${Array(8).fill(0).map(() => 'const x = require("./utils");').join('\n')}`
      : `/src/payments/stripe.js\n/src/payments/webhooks.js\n/src/auth/middleware.js`;
    inputChars = 80 + Math.floor(Math.random() * 200);
    outputChars = 400 + Math.floor(Math.random() * 4000);
  }

  const estIn = Math.ceil(inputChars / 4);
  const estOut = Math.ceil(outputChars / 4);

  return {
    sessionId,
    toolName,
    filePath: isEdit || toolName === 'Read' ? filePath : null,
    timestamp,
    durationMs,
    inputSummary,
    outputSummary,
    inputChars,
    outputChars,
    estIn,
    estOut,
  };
}

/**
 * Generate a realistic sequence of tool events for one session.
 * profile: 'smooth' | 'friction' | 'struggling'
 */
function generateToolEvents(sessionId, sessionStart, files, profile) {
  const profiles = {
    smooth:     { toolCount: [18, 28], errorRate: 0.05, reworkChance: 0.1,  bashErrorRate: 0.1  },
    friction:   { toolCount: [25, 40], errorRate: 0.18, reworkChance: 0.35, bashErrorRate: 0.3  },
    struggling: { toolCount: [35, 55], errorRate: 0.35, reworkChance: 0.6,  bashErrorRate: 0.5  },
  };

  const p = profiles[profile];
  const toolCount = p.toolCount[0] + Math.floor(Math.random() * (p.toolCount[1] - p.toolCount[0]));

  const events = [];
  let cursor = new Date(sessionStart).getTime();

  // Phase 1: exploration (25% of events)
  const exploreCount = Math.floor(toolCount * 0.25);
  for (let i = 0; i < exploreCount; i++) {
    const tool = EXPLORATION_TOOLS[i % EXPLORATION_TOOLS.length];
    const file = files[i % files.length];
    const dur = 800 + Math.floor(Math.random() * 2000);
    events.push(makeToolEvent(sessionId, tool, file, new Date(cursor).toISOString(), dur, { errorRate: 0.02 }));
    cursor += dur + Math.floor(Math.random() * 3000);
  }

  // Phase 2: edit + bash cycles (65% of events)
  const editCount = Math.floor(toolCount * 0.65);
  const editedFiles = [...files]; // track which files we've edited (for rework)
  let lastFile = null;

  for (let i = 0; i < editCount; i++) {
    const isRework = lastFile && Math.random() < p.reworkChance;
    const file = isRework ? lastFile : editedFiles[i % editedFiles.length];

    if (i % 4 === 3) {
      // Every 4th, run bash (test or git)
      const cmds = ['npm test', 'npm run lint', 'git diff --stat', 'node -e "require(\'./src/payments/stripe\')"'];
      const dur = 2000 + Math.floor(Math.random() * 5000);
      events.push(makeToolEvent(sessionId, 'Bash', null, new Date(cursor).toISOString(), dur, {
        errorRate: p.bashErrorRate,
        bashCmd: cmds[i % cmds.length],
      }));
      cursor += dur + Math.floor(Math.random() * 2000);
    } else {
      const tool = EDIT_TOOLS[i % EDIT_TOOLS.length];
      const dur = 500 + Math.floor(Math.random() * 1500);
      events.push(makeToolEvent(sessionId, tool, file, new Date(cursor).toISOString(), dur, { errorRate: p.errorRate }));
      cursor += dur + Math.floor(Math.random() * 2000);
      lastFile = file;
    }
  }

  // Phase 3: wrap-up (10%: final bash, maybe a read)
  const wrapCount = toolCount - exploreCount - editCount;
  for (let i = 0; i < wrapCount; i++) {
    const dur = 1000 + Math.floor(Math.random() * 3000);
    if (i === 0) {
      events.push(makeToolEvent(sessionId, 'Bash', null, new Date(cursor).toISOString(), dur, {
        errorRate: profile === 'smooth' ? 0.05 : 0.1,
        bashCmd: 'npm test',
      }));
    } else {
      events.push(makeToolEvent(sessionId, 'Read', files[0], new Date(cursor).toISOString(), dur));
    }
    cursor += dur + 1000;
  }

  return { events, endTime: new Date(cursor).toISOString() };
}

// ---------------------------------------------------------------------------
// DB insert helpers
// ---------------------------------------------------------------------------

const insertTask = db.prepare(`
  INSERT INTO tasks (id, title, status, assignee, priority, team, created_at, started_at, completed_at, source, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'linear', '{}')
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title, status = excluded.status, assignee = excluded.assignee,
    priority = excluded.priority, team = excluded.team, started_at = excluded.started_at,
    completed_at = excluded.completed_at
`);

const insertSession = db.prepare(`
  INSERT OR REPLACE INTO sessions (id, project_dir, branch, started_at, ended_at, task_id, model,
    conversation_turns, est_input_tokens, est_output_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertToolEvent = db.prepare(`
  INSERT INTO tool_events (session_id, hook_type, tool_name, file_path, timestamp,
    duration_ms, input_summary, output_summary, input_chars, output_chars,
    est_input_tokens, est_output_tokens)
  VALUES (?, 'PostToolUse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertTurn = db.prepare(`
  INSERT OR IGNORE INTO conversation_turns (session_id, turn_number, timestamp, tool_count,
    est_input_tokens, est_output_tokens, stop_reason)
  VALUES (?, ?, ?, ?, ?, ?, 'end_turn')
`);

const insertPR = db.prepare(`
  INSERT OR REPLACE INTO pull_requests (id, repo, title, branch, author, state, created_at, merged_at, task_id, ai_assisted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

// ---------------------------------------------------------------------------
// Seed one session
// ---------------------------------------------------------------------------

function seedSession(sessionId, taskId, branch, sessionStart, files, profile, model) {
  const { events, endTime } = generateToolEvents(sessionId, sessionStart, files, profile);

  // Compute token totals
  const totalInChars = events.reduce((s, e) => s + e.inputChars, 0);
  const totalOutChars = events.reduce((s, e) => s + e.outputChars, 0);
  const estIn = Math.ceil(totalInChars / 4);
  const estOut = Math.ceil(totalOutChars / 4);

  // Fake turns: one every ~8 tool events
  const turns = Math.max(1, Math.floor(events.length / 8));

  insertSession.run(
    sessionId, '/home/dev/acme-platform', branch, sessionStart, endTime,
    taskId, model, turns, estIn, estOut
  );

  for (const ev of events) {
    insertToolEvent.run(
      ev.sessionId, ev.toolName, ev.filePath, ev.timestamp,
      ev.durationMs, ev.inputSummary, ev.outputSummary,
      ev.inputChars, ev.outputChars, ev.estIn, ev.estOut
    );
  }

  // Insert conversation turns
  const eventsPerTurn = Math.floor(events.length / turns);
  for (let t = 1; t <= turns; t++) {
    const turnEvents = events.slice((t - 1) * eventsPerTurn, t * eventsPerTurn);
    const turnIn = Math.ceil(turnEvents.reduce((s, e) => s + e.inputChars, 0) / 4);
    const turnOut = Math.ceil(turnEvents.reduce((s, e) => s + e.outputChars, 0) / 4);
    insertTurn.run(sessionId, t, turnEvents[0]?.timestamp || sessionStart, turnEvents.length, turnIn, turnOut);
  }

  // Compute and store session_metrics
  computeSessionMetrics(sessionId);

  return { sessionId, turns, events: events.length, endTime };
}

// ---------------------------------------------------------------------------
// Clean seeded data
// ---------------------------------------------------------------------------

if (CLEAN) {
  console.log('Cleaning seeded data...');
  db.exec(`DELETE FROM session_metrics WHERE session_id LIKE 'seed-%'`);
  db.exec(`DELETE FROM conversation_turns WHERE session_id LIKE 'seed-%'`);
  db.exec(`DELETE FROM tool_events WHERE session_id LIKE 'seed-%'`);
  db.exec(`DELETE FROM sessions WHERE id LIKE 'seed-%'`);
  db.exec(`DELETE FROM pull_requests WHERE id >= 9000`);
  db.exec(`DELETE FROM tasks WHERE id IN ('TES-7','TES-8','TES-9','TES-10','TES-11','TES-12')`);
  console.log('Done. Run without --clean to re-seed.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Define the sprint
// ---------------------------------------------------------------------------

console.log('Seeding demo data...\n');

const TASKS = [
  {
    id: 'TES-7',
    title: 'Set up Stripe webhook handling',
    status: 'done',
    assignee: 'Girish Verma',
    priority: 1,
    team: 'Engineering',
    createdDaysAgo: 14,
    startedDaysAgo: 13,
    completedDaysAgo: 11,
    branch: 'feat/TES-7-stripe-webhooks',
    files: FILES.payments,
    sessions: [
      { daysAgo: 13, durationMins: 65, profile: 'friction', model: 'claude-sonnet-4' },
      { daysAgo: 12, durationMins: 45, profile: 'smooth',   model: 'claude-sonnet-4' },
      { daysAgo: 11, durationMins: 30, profile: 'smooth',   model: 'claude-sonnet-4' },
    ],
    pr: { id: 9001, title: 'feat: Stripe webhook handler with retry logic', mergedDaysAgo: 11 },
  },
  {
    id: 'TES-8',
    title: 'Fix duplicate charge bug',
    status: 'done',
    assignee: 'Alex Chen',
    priority: 0,
    team: 'Engineering',
    createdDaysAgo: 12,
    startedDaysAgo: 11,
    completedDaysAgo: 10,
    branch: 'fix/TES-8-duplicate-charge',
    files: FILES.payments,
    sessions: [
      { daysAgo: 11, durationMins: 90, profile: 'struggling', model: 'claude-opus-4' },
      { daysAgo: 10, durationMins: 55, profile: 'friction',   model: 'claude-sonnet-4' },
    ],
    pr: { id: 9002, title: 'fix: Prevent duplicate charges with idempotency keys', mergedDaysAgo: 10 },
  },
  {
    id: 'TES-9',
    title: 'Refactor auth middleware',
    status: 'done',
    assignee: 'Maya Patel',
    priority: 2,
    team: 'Engineering',
    createdDaysAgo: 11,
    startedDaysAgo: 10,
    completedDaysAgo: 7,
    branch: 'refactor/TES-9-auth-middleware',
    files: FILES.auth,
    sessions: [
      { daysAgo: 10, durationMins: 70, profile: 'smooth',   model: 'claude-sonnet-4' },
      { daysAgo: 9,  durationMins: 50, profile: 'smooth',   model: 'claude-sonnet-4' },
      { daysAgo: 7,  durationMins: 35, profile: 'smooth',   model: 'claude-sonnet-4' },
    ],
    pr: { id: 9003, title: 'refactor: Consolidate auth middleware with JWT validation', mergedDaysAgo: 7 },
  },
  {
    id: 'TES-10',
    title: 'Add subscription management API',
    status: 'done',
    assignee: 'Girish Verma',
    priority: 1,
    team: 'Engineering',
    createdDaysAgo: 9,
    startedDaysAgo: 8,
    completedDaysAgo: 4,
    branch: 'feat/TES-10-subscription-api',
    files: FILES.subscriptions,
    sessions: [
      { daysAgo: 8, durationMins: 80,  profile: 'smooth',   model: 'claude-sonnet-4' },
      { daysAgo: 7, durationMins: 60,  profile: 'smooth',   model: 'claude-sonnet-4' },
      { daysAgo: 6, durationMins: 45,  profile: 'friction', model: 'claude-sonnet-4' },
      { daysAgo: 4, durationMins: 30,  profile: 'smooth',   model: 'claude-sonnet-4' },
    ],
    pr: { id: 9004, title: 'feat: Subscription CRUD with Stripe plan sync', mergedDaysAgo: 4 },
  },
  {
    id: 'TES-11',
    title: 'Build merchant analytics dashboard',
    status: 'in_progress',
    assignee: 'Alex Chen',
    priority: 1,
    team: 'Engineering',
    createdDaysAgo: 6,
    startedDaysAgo: 5,
    completedDaysAgo: null,
    branch: 'feat/TES-11-merchant-dashboard',
    files: FILES.dashboard,
    sessions: [
      { daysAgo: 5, durationMins: 75, profile: 'friction', model: 'claude-sonnet-4' },
      { daysAgo: 3, durationMins: 60, profile: 'friction', model: 'claude-sonnet-4' },
    ],
    pr: null,
  },
  {
    id: 'TES-12',
    title: 'Add CSV export for transactions',
    status: 'in_progress',
    assignee: 'Maya Patel',
    priority: 2,
    team: 'Engineering',
    createdDaysAgo: 4,
    startedDaysAgo: 3,
    completedDaysAgo: null,
    branch: 'feat/TES-12-csv-export',
    files: FILES.export,
    sessions: [
      { daysAgo: 3, durationMins: 50, profile: 'smooth', model: 'claude-sonnet-4' },
      { daysAgo: 1, durationMins: 40, profile: 'smooth', model: 'claude-sonnet-4' },
    ],
    pr: null,
  },
];

// ---------------------------------------------------------------------------
// Run seed
// ---------------------------------------------------------------------------

for (const task of TASKS) {
  insertTask.run(
    task.id, task.title, task.status, task.assignee, task.priority, task.team,
    daysAgo(task.createdDaysAgo),
    task.startedDaysAgo ? daysAgo(task.startedDaysAgo) : null,
    task.completedDaysAgo ? daysAgo(task.completedDaysAgo) : null
  );

  console.log(`Task ${task.id}: ${task.title} (${task.status})`);

  let sessionIndex = 0;
  for (const s of task.sessions) {
    const sessionId = uuid();
    const sessionStart = daysAgo(s.daysAgo, Math.floor(Math.random() * 480) - 240);
    const result = seedSession(sessionId, task.id, task.branch, sessionStart, task.files, s.profile, s.model);
    console.log(`  Session ${++sessionIndex}: ${s.profile} | ${result.events} events | ${result.turns} turns`);
  }

  if (task.pr) {
    insertPR.run(
      task.pr.id, 'acme-platform', task.pr.title,
      task.branch, task.assignee, 'merged',
      daysAgo(task.startedDaysAgo), daysAgo(task.pr.mergedDaysAgo),
      task.id
    );
    console.log(`  PR #${task.pr.id}: ${task.pr.title}`);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const sessionCount = db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE id LIKE 'seed-%'`).get().c;
const eventCount   = db.prepare(`SELECT COUNT(*) as c FROM tool_events WHERE session_id LIKE 'seed-%'`).get().c;
const taskCount    = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE id IN ('TES-7','TES-8','TES-9','TES-10','TES-11','TES-12')`).get().c;

console.log('='.repeat(50));
console.log(`Seeded: ${taskCount} tasks · ${sessionCount} sessions · ${eventCount} tool events`);
console.log('');
console.log('Run: node scripts/seed-demo.js --clean   to reset');
console.log('');
