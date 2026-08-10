require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

const AGENTS = [
  { name: 'Meredith', email: 'meredith@thelistrealty.com' },
  { name: 'Chris', email: 'chris@thelistrealty.com' },
  { name: 'Rose', email: 'rose@thelistrealty.com' },
  { name: 'Stacy', email: 'stacy@thelistrealty.com' },
  { name: 'Sandy', email: 'sandraleblanc@thelistrealty.com' },
  { name: 'Dale', email: 'dale@thelistrealty.com' },
  { name: 'Patrick', email: 'patrick@thelistrealty.com' },
  { name: 'Jason', email: 'jason@thelistrealty.com' },
  { name: 'Felicia', email: 'felicia@thelistrealty.com' },
  { name: 'Francisco', email: 'francisco@thelistrealty.com' },
];

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Applies schema.sql (safe to run repeatedly, everything uses IF NOT EXISTS)
// and makes sure the 10 agents exist. Called automatically on every server
// startup so new columns/tables show up on deploy with no manual step.
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);

  for (const a of AGENTS) {
    await db.query(
      `INSERT INTO agents (name, email, slug) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
      [a.name, a.email, slugify(a.name)]
    );
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
