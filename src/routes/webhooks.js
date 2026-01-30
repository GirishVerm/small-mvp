const express = require('express');
const db = require('../db');
const { processPush, processPullRequest } = require('../services/github');
const { processIssue } = require('../services/linear');

const router = express.Router();

const insertWebhookLog = db.prepare(`
  INSERT INTO webhook_log (source, event_type, received_at, payload)
  VALUES (?, ?, ?, ?)
`);

// GitHub webhook
router.post(
  '/github',
  express.json({ type: ['application/json', 'application/vnd.github+json'] }),
  (req, res) => {
    const event = req.header('X-GitHub-Event');
    const delivery = req.header('X-GitHub-Delivery');
    const now = new Date().toISOString();

    // Log raw payload
    insertWebhookLog.run('github', event, now, JSON.stringify(req.body));

    console.log(`[GITHUB] event=${event} delivery=${delivery}`);

    try {
      let result = null;

      if (event === 'push') {
        result = processPush(req.body);
        console.log(`[GITHUB] Processed push: ${result.processed} commits on ${result.branch}`);
      } else if (event === 'pull_request') {
        result = processPullRequest(req.body);
        console.log(`[GITHUB] Processed PR #${result?.number}: ${result?.action} (${result?.state}) task=${result?.taskId || 'none'}`);
      } else {
        console.log(`[GITHUB] Unhandled event type: ${event}`);
      }

      res.status(200).json({ received: true, event, result });
    } catch (err) {
      console.error(`[GITHUB ERROR] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }
);

// Linear webhook
router.post(
  '/linear',
  express.json({ type: ['application/json'] }),
  (req, res) => {
    const now = new Date().toISOString();

    // Log raw payload
    insertWebhookLog.run('linear', req.body?.action || req.body?.type, now, JSON.stringify(req.body));

    console.log(`[LINEAR] action=${req.body?.action} type=${req.body?.type}`);

    try {
      const result = processIssue(req.body);
      if (result) {
        console.log(`[LINEAR] Processed ${result.identifier}: ${result.action} → ${result.status}`);
      }

      res.status(200).json({ received: true, result });
    } catch (err) {
      console.error(`[LINEAR ERROR] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
