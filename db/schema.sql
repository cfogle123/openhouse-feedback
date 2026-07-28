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
