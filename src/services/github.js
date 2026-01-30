const db = require('../db');
const { extractTaskId } = require('./correlation');

const upsertCommit = db.prepare(`
  INSERT INTO commits (sha, repo, branch, message, author, timestamp, ai_assisted, task_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sha) DO UPDATE SET
    branch = COALESCE(excluded.branch, commits.branch),
    task_id = COALESCE(excluded.task_id, commits.task_id),
    pr_id = COALESCE(commits.pr_id, excluded.pr_id)
`);

const upsertPR = db.prepare(`
  INSERT INTO pull_requests (id, repo, title, branch, author, state, created_at, merged_at, task_id, ai_assisted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    state = excluded.state,
    merged_at = COALESCE(excluded.merged_at, pull_requests.merged_at),
    title = COALESCE(excluded.title, pull_requests.title),
    ai_assisted = MAX(pull_requests.ai_assisted, excluded.ai_assisted)
`);

const linkCommitToPR = db.prepare(`
  UPDATE commits SET pr_id = ? WHERE sha = ?
`);

function isAiAssisted(message) {
  if (!message) return false;
  return /co-authored-by:.*claude/i.test(message) ||
         /co-authored-by:.*anthropic/i.test(message);
}

function processPush(payload) {
  const repo = payload.repository?.full_name || 'unknown';
  const branch = (payload.ref || '').replace('refs/heads/', '');
  const commits = payload.commits || [];

  let processed = 0;
  for (const commit of commits) {
    const taskId = extractTaskId(branch) || extractTaskId(commit.message);
    const aiAssisted = isAiAssisted(commit.message) ? 1 : 0;

    upsertCommit.run(
      commit.id,
      repo,
      branch,
      commit.message || null,
      commit.author?.username || commit.author?.name || null,
      commit.timestamp || null,
      aiAssisted,
      taskId
    );
    processed++;
  }

  return { processed, branch, repo };
}

function processPullRequest(payload) {
  const pr = payload.pull_request;
  if (!pr) return null;

  const repo = payload.repository?.full_name || 'unknown';
  const branch = pr.head?.ref || null;
  const taskId = extractTaskId(branch) || extractTaskId(pr.title);
  const action = payload.action; // opened, closed, merged, synchronize, etc.

  const state = pr.merged ? 'merged' : pr.state; // 'open', 'closed', or 'merged'

  // Check if any commit in the PR is AI-assisted
  // For now, check the PR body and title
  const aiAssisted = isAiAssisted(pr.body) ? 1 : 0;

  upsertPR.run(
    pr.number,
    repo,
    pr.title || null,
    branch,
    pr.user?.login || null,
    state,
    pr.created_at || null,
    pr.merged_at || null,
    taskId,
    aiAssisted
  );

  // Link existing commits on this branch to the PR
  if (branch) {
    db.prepare(`UPDATE commits SET pr_id = ? WHERE branch = ? AND repo = ?`)
      .run(pr.number, branch, repo);
  }

  // Update PR ai_assisted flag from linked commits
  const aiCommit = db.prepare(`
    SELECT 1 FROM commits WHERE pr_id = ? AND ai_assisted = 1 LIMIT 1
  `).get(pr.number);

  if (aiCommit) {
    db.prepare(`UPDATE pull_requests SET ai_assisted = 1 WHERE id = ?`).run(pr.number);
  }

  return { action, number: pr.number, state, branch, taskId };
}

module.exports = { processPush, processPullRequest, isAiAssisted };
