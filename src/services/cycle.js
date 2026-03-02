const { linearGql, computeHealthLevel } = require('./linear');
const { computeTaskMetrics, getTaskTokenUsage } = require('./metrics');
const db = require('../db');

/**
 * Fetch the active cycle and its issues for a team.
 */
async function getActiveCycle(apiKey, teamId) {
  const data = await linearGql(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        activeCycle {
          id name number startsAt endsAt
          issues {
            nodes { id identifier title state { name } assignee { name } }
          }
        }
      }
    }
  `, { teamId });

  return data?.team?.activeCycle || null;
}

/**
 * For each issue in the active cycle, attach AI health + cost from our DB.
 */
function enrichCycleIssues(issues) {
  return issues.map(issue => {
    const taskId = issue.identifier;

    const eventCount = db.prepare(
      `SELECT COUNT(*) as c FROM tool_events WHERE task_id = ? AND hook_type = 'PostToolUse'`
    ).get(taskId)?.c || 0;

    const hasData = eventCount > 0;
    const metrics = hasData ? computeTaskMetrics(taskId) : null;
    const health = metrics ? computeHealthLevel(metrics) : null;
    const tokenUsage = hasData ? getTaskTokenUsage(taskId) : null;
    const sessionCount = db.prepare(
      `SELECT COUNT(DISTINCT id) as c FROM sessions WHERE task_id = ?`
    ).get(taskId)?.c || 0;

    return {
      identifier: taskId,
      title: issue.title,
      state: issue.state?.name,
      assignee: issue.assignee?.name || null,
      ai_health: health,
      session_count: sessionCount,
      error_rate: metrics?.error_rate ?? null,
      edit_success_rate: metrics?.edit_success_rate ?? null,
      est_cost_usd: tokenUsage?.est_cost_usd || 0,
      total_turns: tokenUsage?.total_turns || 0,
    };
  });
}

/**
 * Full cycle dashboard — active cycle metadata + per-issue AI health.
 */
async function getCycleDashboard(apiKey, teamId) {
  const cycle = await getActiveCycle(apiKey, teamId);
  if (!cycle) return null;

  const issues = cycle.issues?.nodes || [];
  const enriched = enrichCycleIssues(issues);

  const healthCounts = { smooth: 0, friction: 0, struggling: 0, untracked: 0 };
  let totalCost = 0;
  let totalTurns = 0;

  for (const issue of enriched) {
    if (issue.ai_health) healthCounts[issue.ai_health]++;
    else healthCounts.untracked++;
    totalCost += issue.est_cost_usd;
    totalTurns += issue.total_turns;
  }

  return {
    cycle: {
      id: cycle.id,
      name: cycle.name,
      number: cycle.number,
      starts_at: cycle.startsAt,
      ends_at: cycle.endsAt,
    },
    summary: {
      total_issues: enriched.length,
      ...healthCounts,
      total_est_cost_usd: Math.round(totalCost * 10000) / 10000,
      total_turns: totalTurns,
    },
    issues: enriched,
  };
}

module.exports = { getActiveCycle, enrichCycleIssues, getCycleDashboard };
