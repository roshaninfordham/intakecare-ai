-- CareLine AI — intake sessions keyed by phone number (the omnichannel session key)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- normalized phone number, e.g. +15551234567
  status TEXT NOT NULL DEFAULT 'collecting',  -- greeting | collecting | confirming | complete | handoff
  fields TEXT NOT NULL DEFAULT '{}',           -- extracted intake fields (JSON)
  packet TEXT,                                  -- generated start-of-care packet (JSON)
  language TEXT DEFAULT 'en',
  last_channel TEXT DEFAULT 'whatsapp',         -- whatsapp | sms | voice
  awaiting_doc INTEGER DEFAULT 0,               -- voice call asked for a doc over text
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- user | agent
  channel TEXT NOT NULL,            -- whatsapp | sms | voice
  kind TEXT NOT NULL DEFAULT 'text',-- text | audio | image | pdf | call
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

-- Guardrail & system event log (shown on the dashboard for judges)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  kind TEXT NOT NULL,               -- guardrail | handoff | media | llm_fallback | packet | system
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

-- RAG knowledge chunks with embeddings (cosine similarity computed in the Worker)
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  chunk TEXT NOT NULL,
  embedding TEXT                    -- JSON array of floats from @cf/baai/bge-base-en-v1.5
);
