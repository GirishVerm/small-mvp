const express = require('express');
const { getCycleDashboard } = require('../services/cycle');

const router = express.Router();

const TEAM_ID = process.env.LINEAR_TEAM_ID || '7f48dece-a426-4deb-9ea9-0d4dd953e0ad';

// GET /cycle — active cycle dashboard with per-issue AI health
router.get('/', async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'LINEAR_API_KEY not set' });

  try {
    const dashboard = await getCycleDashboard(apiKey, TEAM_ID);
    if (!dashboard) return res.status(404).json({ error: 'No active cycle found' });
    res.json(dashboard);
  } catch (err) {
    console.error('[CYCLE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
