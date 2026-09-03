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

-- Uploaded via the House Addresses admin page. Stored directly in the
-- database (not as files on disk) because Render's free plan wipes
-- anything written to disk outside the git repo on every redeploy -- the
-- database is the only place on this stack that reliably persists. The 5
-- house photos added earlier via manual file upload to public/house-photos/
-- still work as a fallback (see getHousePhotoUrl in server.js); newly
-- added/replaced photos going forward live here instead.
ALTER TABLE houses ADD COLUMN IF NOT EXISTS photo BYTEA;
ALTER TABLE houses ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE houses ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMP;

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

-- Reminder tracking: reminder_sent_at is set once the "update Chris & Meredith"
-- nudge has actually gone out for this slot's current house/date/hours/agent
-- combination. server.js resets both columns back to NULL whenever any of
-- those four fields change on save, so re-using a slot for a different open
-- house later still gets its own reminder.
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP;
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_error TEXT;
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_email_sent_at TIMESTAMP;
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_email_error TEXT;
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_slack_sent_at TIMESTAMP;
ALTER TABLE open_house_schedule ADD COLUMN IF NOT EXISTS reminder_slack_error TEXT;

-- 'agent' = typed in by the hosting agent after the fact (the original
-- feedback form). 'visitor' = the visitor signed themself in on a shared
-- device at the open house (the /signin flow). Purely informational so
-- admin views can show where a record came from.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent';

-- Fields collected only by the visitor self-sign-in kiosk (/signin flow),
-- always NULL on entries created via the agent feedback form. buyer_name
-- stays populated too (first + last combined) so every existing admin view,
-- CSV export, and Follow Up Boss call that already reads buyer_name keeps
-- working unchanged.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS buyer_first_name TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS buyer_last_name TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS visitor_home_address TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS owns_or_rents TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS wants_off_market_info BOOLEAN;

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

-- Shared document library for open house sign placement plans (PDFs and
-- Word docs) -- not tied to any specific address, just a flat list any
-- agent can add to or pull from. Stored as BYTEA for the same reason as
-- house photos: Render's free plan wipes anything written to disk outside
-- the git repo on every redeploy, so the database is the only reliable
-- place to keep uploaded files.
CREATE TABLE IF NOT EXISTS sign_plans (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  uploaded_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- "Maybe" was removed as a choice everywhere (the manual entry form only
-- offers Yes/No now). Visitor self sign-ins never ask an interest question
-- at all, though, so instead of inventing a new fake default, entries.interested
-- is now left NULL for those until an agent reviews and sets it -- shown as
-- "Not set" in admin/agent tables (see the badge rendering in agent.ejs,
-- admin.ejs, admin-feedback.ejs, house-detail.ejs). Existing rows already
-- saved as 'Maybe' are left alone; this only changes what happens going
-- forward.
ALTER TABLE entries ALTER COLUMN interested DROP DEFAULT;
ALTER TABLE entries ALTER COLUMN interested DROP NOT NULL;
