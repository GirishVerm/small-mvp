const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.ANALYTICS_DB_PATH || path.join(__dirname, '../../data/analytics.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Migrations: add new columns to existing tables (idempotent)
const migrations = [
  'ALTER TABLE sessions ADD COLUMN model TEXT',
  'ALTER TABLE sessions ADD COLUMN conversation_turns INTEGER DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN est_input_tokens INTEGER DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN est_output_tokens INTEGER DEFAULT 0',
  'ALTER TABLE tool_events ADD COLUMN input_chars INTEGER DEFAULT 0',
  'ALTER TABLE tool_events ADD COLUMN output_chars INTEGER DEFAULT 0',
  'ALTER TABLE tool_events ADD COLUMN est_input_tokens INTEGER DEFAULT 0',
  'ALTER TABLE tool_events ADD COLUMN est_output_tokens INTEGER DEFAULT 0',
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      console.warn(`[DB MIGRATION] ${err.message}`);
    }
  }
}

console.log(`[DB] SQLite initialized at ${DB_PATH}`);

module.exports = db;
