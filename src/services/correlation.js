const PATTERNS = [
  /([A-Z]{2,10}-\d+)/,         // Linear/Jira: ABC-123
  /#(\d+)/,                      // GitHub issues: #42
  /(?:^|\/)(\d+)(?:-|$)/,       // Numeric branch: feat/123-add-login
];

function extractTaskId(text) {
  if (!text) return null;
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

module.exports = { extractTaskId };
