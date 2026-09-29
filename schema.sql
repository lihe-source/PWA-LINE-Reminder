CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  line_user_id TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  message TEXT NOT NULL,
  source_text TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','failed','cancelled')),
  retry_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  next_attempt_at TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(recipient_id) REFERENCES contacts(id)
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, due_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS tasks_cleanup ON tasks(status, sent_at, updated_at);
