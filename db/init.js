require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

const AGENTS = [
  { name: 'Meredith', email: 'meredith@thelistrealty.com' },
  { name: 'Chris', email: 'chris@thelistrealty.com' },
  { name: 'Rose', email: 'rose@thelistrealty.com' },
  { name: 'Stacy', email: 'stacy@thelistrealty.com' },
  { name: 'Sandy', email: 'sandyleblanc@thelistrealty.com' },
  { name: 'Dale', email: 'dale@thelistrealty.com' },
  { name: 'Patrick', email: 'patrick@thelistrealty.com' },
  { name: 'Jason', email: 'jason@thelistrealty.com' },
  { name: 'Felicia', email: 'felicia@thelistrealty.com' },
  { name: 'Francisco', email: 'francisco@thelistrealty.com' },
];

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Supabase automatically exposes every table in the "public" schema through
// a public REST API (PostgREST) using its anon key, completely separate from
// this app's own direct database connection -- even though the app never
// uses that API. Row Level Security defaults to OFF on new tables, which
// means anyone with the project's URL + anon key could read/write/delete
// these tables straight through that API. Enabling RLS with no policies
// blocks that public API path entirely (default-deny) while leaving this
// app unaffected, since it connects with the database owner role from
// DATABASE_URL, which always bypasses RLS regardless of policies.
const RLS_TABLES = ['agents', 'houses', 'entries', 'availability', 'availability_day_notes', 'open_house_schedule'];

// Applies schema.sql (safe to run repeatedly, everything uses IF NOT EXISTS)
// and makes sure the 10 agents exist. Called automatically on every server
// startup so new columns/tables show up on deploy with no manual step.
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);

  for (const a of AGENTS) {
    await db.query(
      `INSERT INTO agents (name, email, slug) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
      [a.name, a.email, slugify(a.name)]
    );
  }

  // Enabling RLS is a one-way ratchet (safe to re-run) but its exact syntax
  // isn't something every Postgres-compatible tool implements, so each table
  // is wrapped individually -- a hiccup on one shouldn't block the app from
  // starting or stop the rest from being secured.
  for (const table of RLS_TABLES) {
    try {
      await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    } catch (e) {
      console.warn(`Could not enable Row Level Security on "${table}": ${e.message}`);
    }
  }

  console.log(`Database ready. ${AGENTS.length} agents seeded.`);
}

module.exports = { migrate };

// Still runnable directly (`npm run seed`) for local setup or manual re-sync.
if (require.main === module) {
  migrate()
    .then(() => db.pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
