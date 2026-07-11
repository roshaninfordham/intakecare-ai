-- Closing the loop: real scheduling. Synthetic clinic/agency calendar + booked appointments.
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts TEXT NOT NULL,            -- ISO datetime
  label TEXT NOT NULL,               -- human-readable, e.g. "Mon Jul 13, 10:00 AM"
  kind TEXT NOT NULL,                -- soc_visit (RN at home) | clinic_followup
  clinician TEXT NOT NULL,
  location TEXT NOT NULL,
  booked INTEGER DEFAULT 0,
  booked_by TEXT
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  slot_id INTEGER NOT NULL,
  ref_id TEXT,
  patient_name TEXT,
  start_ts TEXT,
  label TEXT,
  kind TEXT,
  clinician TEXT,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appts_session ON appointments(session_id);
