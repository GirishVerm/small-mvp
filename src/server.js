require('dotenv').config();

const express = require('express');
const db = require('./db');
const hooksRouter = require('./routes/hooks');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const port = process.env.PORT || 3000;

// Mount routes
app.use('/hooks/claude', hooksRouter);
app.use('/webhooks', webhooksRouter);

// Health check
app.get('/health', (req, res) => {
  const stats = {
    ok: true,
    sessions: db.prepare('SELECT COUNT(*) as c FROM sessions').get().c,
    tool_events: db.prepare('SELECT COUNT(*) as c FROM tool_events').get().c,
    tasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
    commits: db.prepare('SELECT COUNT(*) as c FROM commits').get().c,
    pull_requests: db.prepare('SELECT COUNT(*) as c FROM pull_requests').get().c,
  };
  res.json(stats);
});

app.listen(port, () => {
  console.log(`Claude Analytics server listening on http://localhost:${port}`);
  console.log('');
  console.log('  Ingestion:');
  console.log('    POST /hooks/claude        Claude Code hooks');
  console.log('    POST /webhooks/github     GitHub webhooks');
  console.log('    POST /webhooks/linear     Linear webhooks');
  console.log('');
  console.log('  Query:');
  console.log('    GET  /health                                Server stats');
  console.log('    GET  /hooks/claude/sessions                 Sessions list');
  console.log('    GET  /hooks/claude/sessions/:id/events      Session events');
  console.log('    GET  /hooks/claude/sessions/:id/metrics     Quality metrics');
  console.log('    GET  /hooks/claude/sessions/:id/turns       Conversation turns');
  console.log('    GET  /hooks/claude/metrics/tokens           Token usage summary');
  console.log('    GET  /hooks/claude/metrics/models           Model usage breakdown');
  console.log('    GET  /hooks/claude/metrics/quality          Quality leaderboard');
});
