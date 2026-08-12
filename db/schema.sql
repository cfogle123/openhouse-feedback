CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  address TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,
  buyer_email TEXT,
  interested TEXT NOT NULL DEFAULT 'Maybe',
  has_agent BOOLEAN NOT NULL DEFAULT false,
  feedback TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS houses (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS buyer_agent_name TEXT;

CREATE TABLE IF NOT EXISTS availability (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unset',
  comment TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (agent_id, date)
);

CREATE TABLE IF NOT EXISTS availability_day_notes (
  date DATE PRIMARY KEY,
  assignment TEXT
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS fub_synced_at TIMESTAMP;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS fub_error TEXT;

CREATE TABLE IF NOT EXISTS open_house_schedule (
  slot INTEGER PRIMARY KEY,
  house_address TEXT,
  date DATE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL
);

-- Which time block this house is being held open for. Free-text rather than
-- an enum so we're not stuck if the two standard windows ever change; the
-- admin-schedule.ejs dropdown is what actually constrains the choices day to
-- day.
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS hours TEXT;

-- 'agent' = typed in by the hosting agent after the fact (the original
-- feedback form). 'visitor' = the visitor signed themself in on a shared
-- device at the open house (the /signin flow). Purely informational so
-- admin views can show where a record came from.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent';

CREATE TABLE IF NOT EXISTS open_house_updates (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  date DATE NOT NULL,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  interested_count INTEGER NOT NULL DEFAULT 0,
  email_sent_at TIMESTAMP,
  email_error TEXT,
  slack_sent_at TIMESTAMP,
  slack_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE open_house_updates ADD COLUMN IF NOT EXISTS comments TEXT;
