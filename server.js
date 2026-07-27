require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const INTEREST_OPTIONS = ['Yes', 'No', 'Maybe'];

function formatDateInput(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function mapEntryRow(row) {
  return {
    id: row.id,
    date: row.date,
    address: row.address,
    buyerName: row.buyer_name,
    buyerPhone: row.buyer_phone,
    buyerEmail: row.buyer_email,
    interested: row.interested,
    hasAgent: row.has_agent,
    buyerAgentName: row.buyer_agent_name,
    feedback: row.feedback,
    agentName: row.agent_name,
  };
}

// Groups an already date-sorted list of entries into address buckets,
// preserving the order the addresses first appear in (i.e. most recent activity first).
function groupByAddress(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.address && e.address.trim() ? e.address.trim() : '(No address)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return Array.from(map.entries()).map(([address, items]) => ({ address, entries: items }));
}

async function getHouses() {
  const { rows } = await db.query('SELECT * FROM houses ORDER BY address ASC');
  return rows;
}

// Home: pick your name
app.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM agents ORDER BY name ASC');
    res.render('home', { agents: rows });
  } catch (err) { next(err); }
});

// Agent page: form + their own entries, grouped by house
app.get('/agent/:slug', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const { rows } = await db.query(
      'SELECT * FROM entries WHERE agent_id = $1 ORDER BY date DESC, id DESC',
      [agent.id]
    );
    const entries = rows.map(mapEntryRow);
    const houses = await getHouses();
    res.render('agent', {
      agent,
      groups: groupByAddress(entries),
      totalCount: entries.length,
      houses,
      interestOptions: INTEREST_OPTIONS,
      today: formatDateInput(new Date()),
      editEntry: null,
    });
  } catch (err) { next(err); }
});

// Edit form for one entry
app.get('/agent/:slug/entries/:id/edit', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const { rows } = await db.query(
      'SELECT * FROM entries WHERE agent_id = $1 ORDER BY date DESC, id DESC',
      [agent.id]
    );
    const entries = rows.map(mapEntryRow);
    const houses = await getHouses();
    const found = entries.find((e) => String(e.id) === req.params.id);
    const editEntry = found ? { ...found, dateInput: formatDateInput(found.date) } : null;
    res.render('agent', {
      agent,
      groups: groupByAddress(entries),
      totalCount: entries.length,
      houses,
      interestOptions: INTEREST_OPTIONS,
      today: formatDateInput(new Date()),
      editEntry,
    });
  } catch (err) { next(err); }
});

// Create entry
app.post('/agent/:slug/entries', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const { date, address, buyerName, buyerPhone, buyerEmail, interested, hasAgent, buyerAgentName, feedback } = req.body;
    const hasAgentBool = hasAgent === 'on';
    await db.query(
      `INSERT INTO entries (agent_id, date, address, buyer_name, buyer_phone, buyer_email, interested, has_agent, buyer_agent_name, feedback)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [agent.id, date, (address || '').trim(), buyerName, buyerPhone || null, buyerEmail || null, interested || 'Maybe', hasAgentBool, hasAgentBool ? ((buyerAgentName || '').trim() || null) : null, feedback || null]
    );
    if (address && address.trim()) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address.trim()]);
    }
    res.redirect(`/agent/${agent.slug}`);
  } catch (err) { next(err); }
});

// Update entry
app.post('/agent/:slug/entries/:id', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const { date, address, buyerName, buyerPhone, buyerEmail, interested, hasAgent, buyerAgentName, feedback } = req.body;
    const hasAgentBool = hasAgent === 'on';
    await db.query(
      `UPDATE entries SET date = $1, address = $2, buyer_name = $3, buyer_phone = $4, buyer_email = $5,
       interested = $6, has_agent = $7, buyer_agent_name = $8, feedback = $9 WHERE id = $10 AND agent_id = $11`,
      [date, (address || '').trim(), buyerName, buyerPhone || null, buyerEmail || null, interested || 'Maybe', hasAgentBool, hasAgentBool ? ((buyerAgentName || '').trim() || null) : null, feedback || null, req.params.id, agent.id]
    );
    if (address && address.trim()) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address.trim()]);
    }
    res.redirect(`/agent/${agent.slug}`);
  } catch (err) { next(err); }
});

// Delete entry
app.post('/agent/:slug/entries/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM entries WHERE id = $1', [req.params.id]);
    res.redirect(`/agent/${req.params.slug}`);
  } catch (err) { next(err); }
});

// Admin: all entries across all agents, grouped by house
app.get('/admin', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT entries.*, agents.name AS agent_name FROM entries
       JOIN agents ON agents.id = entries.agent_id
       ORDER BY date DESC, entries.id DESC`
    );
    const entries = rows.map(mapEntryRow);
    res.render('admin', { groups: groupByAddress(entries), totalCount: entries.length });
  } catch (err) { next(err); }
});

// Admin: manage the list of house addresses (suggestions shown on the entry form)
app.get('/admin/houses', async (req, res, next) => {
  try {
    const houses = await getHouses();
    res.render('admin-houses', { houses });
  } catch (err) { next(err); }
});

app.post('/admin/houses', async (req, res, next) => {
  try {
    const address = (req.body.address || '').trim();
    if (address) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address]);
    }
    res.redirect('/admin/houses');
  } catch (err) { next(err); }
});

app.post('/admin/houses/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM houses WHERE id = $1', [req.params.id]);
    res.redirect('/admin/houses');
  } catch (err) { next(err); }
});

// Browse responses grouped by house, with bulk-delete
app.get('/houses', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT address, COUNT(*)::int AS count, MAX(date) AS last_date
       FROM entries GROUP BY address ORDER BY last_date DESC`
    );
    res.render('houses', { houses: rows });
  } catch (err) { next(err); }
});

app.get('/houses/:address', async (req, res, next) => {
  try {
    const address = decodeURIComponent(req.params.address);
    const { rows } = await db.query(
      `SELECT entries.*, agents.name AS agent_name FROM entries
       JOIN agents ON agents.id = entries.agent_id
       WHERE entries.address = $1
       ORDER BY date DESC, entries.id DESC`,
      [address]
    );
    res.render('house-detail', { address, entries: rows.map(mapEntryRow) });
  } catch (err) { next(err); }
});

app.post('/houses/:address/delete', async (req, res, next) => {
  try {
    const address = decodeURIComponent(req.params.address);
    let ids = req.body.entryIds || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.filter(Boolean).map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id));
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      await db.query(`DELETE FROM entries WHERE address = $1 AND id IN (${placeholders})`, [address, ...ids]);
    }
    res.redirect(`/houses/${encodeURIComponent(address)}`);
  } catch (err) { next(err); }
});

// CSV export
app.get('/admin/export.csv', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT entries.*, agents.name AS agent_name FROM entries
       JOIN agents ON agents.id = entries.agent_id
       ORDER BY date DESC, entries.id DESC`
    );
    const entries = rows.map(mapEntryRow);
    const header = 'Date,Address,Buyer Name,Buyer Phone,Buyer Email,Agent,Has Own Agent,Buyer\'s Agent Name,Interested,Feedback/Notes\n';
    const csvRows = entries.map((e) => {
      const cells = [
        formatDateInput(e.date),
        e.address,
        e.buyerName,
        e.buyerPhone || '',
        e.buyerEmail || '',
        e.agentName,
        e.hasAgent ? 'Yes' : 'No',
        e.buyerAgentName || '',
        e.interested,
        (e.feedback || '').replace(/\n/g, ' '),
      ];
      return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="open-house-feedback.csv"');
    res.send(header + csvRows.join('\n'));
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong: ' + err.message);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Open House Feedback app running on port ${PORT}`));
}

module.exports = app;
