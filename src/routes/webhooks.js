const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { processPush, processPullRequest } = require('../services/github');
const { processIssue } = require('../services/linear');

const router = express.Router();

const insertWebhookLog = db.prepare(`
  INSERT INTO webhook_log (source, event_type, received_at, payload)
  VALUES (?, ?, ?, ?)
`);

function verifyGithubSignature(req, res, buf) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return; // skip verification if secret not configured
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) { req.signatureError = 'missing X-Hub-Signature-256'; return; }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    req.signatureError = 'signature mismatch';
  }
}

function verifyLinearSignature(req, res, buf) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return;
  const sig = req.headers['linear-signature'];
  if (!sig) { req.signatureError = 'missing Linear-Signature'; return; }
  const expected = crypto.createHmac('sha256', secret).update(buf).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    req.signatureError = 'signature mismatch';
  }
}

// GitHub webhook
router.post(
  '/github',
  express.json({ type: ['application/json', 'application/vnd.github+json'], verify: verifyGithubSignature }),
  (req, res) => {
    if (req.signatureError) {
      console.warn(`[GITHUB] Rejected: ${req.signatureError}`);
      return res.status(401).json({ error: req.signatureError });
    }
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
  express.json({ type: ['application/json'], verify: verifyLinearSignature }),
  (req, res) => {
    if (req.signatureError) {
      console.warn(`[LINEAR] Rejected: ${req.signatureError}`);
      return res.status(401).json({ error: req.signatureError });
    }
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
