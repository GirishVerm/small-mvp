CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT,
  branch TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  task_id TEXT
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  file_path TEXT,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  input_summary TEXT,
  output_summary TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  assignee TEXT,
  priority INTEGER,
  team TEXT,
  created_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'linear',
  raw_data TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  title TEXT,
  branch TEXT,
  author TEXT,
  state TEXT,
  created_at TEXT,
  merged_at TEXT,
  task_id TEXT,
  ai_assisted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT,
  message TEXT,
  author TEXT,
  timestamp TEXT,
  pr_id INTEGER,
  ai_assisted INTEGER DEFAULT 0,
  task_id TEXT
);

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event_type TEXT,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  tool_count INTEGER DEFAULT 0,
  est_input_tokens INTEGER DEFAULT 0,
  est_output_tokens INTEGER DEFAULT 0,
  stop_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id TEXT PRIMARY KEY,
  total_tools INTEGER DEFAULT 0,
  total_errors INTEGER DEFAULT 0,
  error_rate REAL DEFAULT 0,
  total_edits INTEGER DEFAULT 0,
  successful_edits INTEGER DEFAULT 0,
  edit_success_rate REAL DEFAULT 0,
  productivity_score REAL DEFAULT 0,
  files_touched INTEGER DEFAULT 0,
  tool_diversity INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_branch ON sessions(branch);
CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool ON tool_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_commits_task ON commits(task_id);
CREATE INDEX IF NOT EXISTS idx_pr_task ON pull_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_session ON conversation_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_session_metrics_error_rate ON session_metrics(error_rate);
