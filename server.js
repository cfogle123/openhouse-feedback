require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { migrate } = require('./db/init');
const { sendOpenHouseLead } = require('./lib/followUpBoss');
const { sendOpenHouseUpdateEmail, sendOpenHouseUpdateSlack } = require('./lib/notifications');

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
    source: row.source,
    agentName: row.agent_name,
    fubSyncedAt: row.fub_synced_at,
    fubError: row.fub_error,
  };
}

function groupByAddress(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.address && e.address.trim() ? e.address.trim() : '(No address)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return Array.from(map.entries()).map(([address, items]) => ({ address, entries: items }));
}

async function syncEntryToFollowUpBoss(entryId, entry) {
  try {
    const result = await sendOpenHouseLead(entry);
    if (result && result.skipped) return; // Follow Up Boss not configured; leave status untouched.
    if (result.assigned === false && result.unassignedReason) {
      // Tagged successfully, but couldn't assign to the right agent — still
      // a success (fub_synced_at set), but flag the reason so it's visible
      // in the CRM column instead of silently landing on Follow Up Boss's
      // default assignee.
      await db.query(
        'UPDATE entries SET fub_synced_at = now(), fub_error = $2 WHERE id = $1',
        [entryId, `Tagged, but not assigned: ${result.unassignedReason}`.slice(0, 500)]
      );
    } else {
      await db.query('UPDATE entries SET fub_synced_at = now(), fub_error = NULL WHERE id = $1', [entryId]);
    }
  } catch (err) {
    console.error('Follow Up Boss sync failed for entry', entryId, err.message);
    await db.query('UPDATE entries SET fub_error = $2 WHERE id = $1', [entryId, String(err.message).slice(0, 500)]);
  }
}

// Fire-and-forget: don't make the agent wait on Resend/Slack (which could
// be slow or briefly down) before their update submits. The record is
// already saved either way; email/Slack status is tracked for debugging but
// not currently shown anywhere in the UI.
async function notifyOpenHouseUpdate(updateId, update) {
  try {
    const result = await sendOpenHouseUpdateEmail(update);
    if (!result.skipped) {
      await db.query('UPDATE open_house_updates SET email_sent_at = now(), email_error = NULL WHERE id = $1', [updateId]);
    }
  } catch (err) {
    console.error('Open house update email failed for update', updateId, err.message);
    await db.query('UPDATE open_house_updates SET email_error = $2 WHERE id = $1', [updateId, String(err.message).slice(0, 500)]);
  }
  try {
    const result = await sendOpenHouseUpdateSlack(update);
    if (!result.skipped) {
      await db.query('UPDATE open_house_updates SET slack_sent_at = now(), slack_error = NULL WHERE id = $1', [updateId]);
    }
  } catch (err) {
    console.error('Open house update Slack message failed for update', updateId, err.message);
    await db.query('UPDATE open_house_updates SET slack_error = $2 WHERE id = $1', [updateId, String(err.message).slice(0, 500)]);
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

// All date values here are kept as UTC-midnight Date objects. This matters because
// node-postgres returns DATE columns as UTC-midnight Date objects regardless of server
// timezone, so using local getters (getDate/getMonth/etc.) would shift the day by one
// whenever the server runs in a negative UTC-offset timezone. Using UTC getters
// everywhere keeps the generated dates and the DB round-tripped dates consistent.
function toDateKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatDayLabel(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Every remaining Friday/Saturday/Sunday between today and Dec 31 of the current year.
function getRemainingWeekendDates() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const end = new Date(Date.UTC(now.getFullYear(), 11, 31));
  const dates = [];
  let cursor = start;
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day === 5 || day === 6 || day === 0) {
      dates.push(new Date(cursor));
    }
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return dates;
}

async function getHouses() {
  const { rows } = await db.query('SELECT * FROM houses ORDER BY address ASC');
  return rows;
}

// Agent headshots are plain static files dropped into public/headshots/,
// named after the agent's slug (e.g. sandy.jpg). No upload UI and nothing in
// the database -- just a file on disk, same pattern as logo.png. If none of
// the supported extensions exist for an agent, photoUrl is null and the
// templates fall back to showing their initial in a circle, so this is safe
// to ship before any photos have been added.
const HEADSHOT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
function getAgentPhotoUrl(slug) {
  for (const ext of HEADSHOT_EXTENSIONS) {
    const filePath = path.join(__dirname, 'public', 'headshots', `${slug}.${ext}`);
    if (fs.existsSync(filePath)) return `/headshots/${slug}.${ext}`;
  }
  return null;
}
function withPhotoUrls(agents) {
  return agents.map((a) => ({ ...a, photoUrl: getAgentPhotoUrl(a.slug) }));
}

// House photos work the same way as agent headshots: a plain static file in
// public/house-photos/, named after a slugified version of the address
// (since houses are just free-text addresses, not a fixed slug column).
function slugifyAddress(address) {
  return String(address || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function getHousePhotoUrl(address) {
  const slug = slugifyAddress(address);
  if (!slug) return null;
  for (const ext of HEADSHOT_EXTENSIONS) {
    const filePath = path.join(__dirname, 'public', 'house-photos', `${slug}.${ext}`);
    if (fs.existsSync(filePath)) return `/house-photos/${slug}.${ext}`;
  }
  return null;
}

// Agent id -> house address for whatever's scheduled today, used to
// auto-suggest the right house on the visitor sign-in start screen so the
// agent usually doesn't have to pick it manually.
async function getTodaysScheduleByAgent() {
  const today = formatDateInput(new Date());
  const { rows } = await db.query(
    `SELECT agent_id, house_address FROM open_house_schedule WHERE date = $1 AND agent_id IS NOT NULL AND house_address IS NOT NULL AND house_address != ''`,
    [today]
  );
  const map = {};
  for (const r of rows) map[r.agent_id] = r.house_address;
  return map;
}

// Home: pick your name
app.get('/', (req, res) => {
  res.render('home');
});

// Feedback: pick your name
app.get('/feedback', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM agents ORDER BY name ASC');
    res.render('feedback-agents', { agents: withPhotoUrls(rows) });
  } catch (err) { next(err); }
});

// Availability: pick your name
app.get('/availability', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM agents ORDER BY name ASC');
    res.render('availability-agents', { agents: withPhotoUrls(rows) });
  } catch (err) { next(err); }
});

// Visitor sign-in, step 1: pick your name.
app.get('/signin', async (req, res, next) => {
  try {
    const { rows: agents } = await db.query('SELECT * FROM agents ORDER BY name ASC');
    res.render('signin-agents', { agents: withPhotoUrls(agents) });
  } catch (err) { next(err); }
});

// Visitor sign-in, step 2: pick (or confirm) which house you're holding
// open. Pre-filled from today's Open House Schedule for this agent, if set.
app.get('/signin/house/:slug', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.redirect('/signin');
    const houses = await getHouses();
    const scheduleByAgent = await getTodaysScheduleByAgent();
    res.render('signin-house', { agent, houses, suggestedHouse: scheduleByAgent[agent.id] || '' });
  } catch (err) { next(err); }
});

// Visitor sign-in: the repeating kiosk-style form. Address comes from the
// query string (set on the start screen) and is shown read-only here so a
// whole run of visitors at the same open house doesn't have to re-pick it.
app.get('/signin/session', async (req, res, next) => {
  try {
    const { agent: slug, house, submitted } = req.query;
    if (!slug || !house) return res.redirect('/signin');
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [slug]);
    const agent = agentRows[0];
    if (!agent) return res.redirect('/signin');
    agent.photoUrl = getAgentPhotoUrl(agent.slug);
    res.render('signin-session', {
      agent,
      house,
      housePhotoUrl: getHousePhotoUrl(house),
      interestOptions: INTEREST_OPTIONS,
      submitted: submitted === '1',
    });
  } catch (err) { next(err); }
});

// Visitor sign-in: create the entry. Reuses the same entries table and the
// same Follow Up Boss sync path as the agent-entered feedback form, just
// tagged source='visitor' so it's clear where it came from.
app.post('/signin/session', async (req, res, next) => {
  try {
    const { agentSlug, house, visitorName, visitorPhone, visitorEmail, interested, hasAgent, visitorAgentName, comments } = req.body;
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [agentSlug]);
    const agent = agentRows[0];
    if (!agent) return res.redirect('/signin');
    const hasAgentBool = hasAgent === 'on';
    const address = (house || '').trim();
    const date = formatDateInput(new Date());
    const { rows: inserted } = await db.query(
      `INSERT INTO entries (agent_id, date, address, buyer_name, buyer_phone, buyer_email, interested, has_agent, buyer_agent_name, feedback, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'visitor') RETURNING id`,
      [agent.id, date, address, visitorName, visitorPhone || null, visitorEmail || null, interested || 'Maybe', hasAgentBool, hasAgentBool ? ((visitorAgentName || '').trim() || null) : null, comments || null]
    );
    if (address) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address]);
    }
    if (!hasAgentBool) {
      syncEntryToFollowUpBoss(inserted[0].id, {
        agentName: agent.name,
        agentEmail: agent.email,
        buyerName: visitorName,
        buyerPhone: visitorPhone,
        buyerEmail: visitorEmail,
        address,
        feedback: comments,
        interested: interested || 'Maybe',
      });
    }
    res.redirect(`/signin/session?agent=${encodeURIComponent(agent.slug)}&house=${encodeURIComponent(address)}&submitted=1`);
  } catch (err) { next(err); }
});

// Open House Update, step 1: pick your name.
app.get('/update', async (req, res, next) => {
  try {
    const { rows: agents } = await db.query('SELECT * FROM agents ORDER BY name ASC');
    res.render('update-agents', { agents: withPhotoUrls(agents) });
  } catch (err) { next(err); }
});

// Open House Update, step 2: the recap form (house, visitor count, interested count).
app.get('/update/:slug', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const houses = await getHouses();
    res.render('update-form', {
      agent,
      houses,
      today: formatDateInput(new Date()),
      submitted: req.query.submitted === '1',
    });
  } catch (err) { next(err); }
});

// Open House Update: save the recap, then email + Slack it to Chris and Meredith.
app.post('/update/:slug', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');
    const { date, address, visitorCount, interestedCount } = req.body;
    const addressTrimmed = (address || '').trim();
    const visitorCountNum = Math.max(0, parseInt(visitorCount, 10) || 0);
    const interestedCountNum = Math.max(0, parseInt(interestedCount, 10) || 0);
    const dateValue = date || formatDateInput(new Date());

    const { rows: inserted } = await db.query(
      `INSERT INTO open_house_updates (agent_id, address, date, visitor_count, interested_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [agent.id, addressTrimmed, dateValue, visitorCountNum, interestedCountNum]
    );
    if (addressTrimmed) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [addressTrimmed]);
    }

    // Fire-and-forget, same reasoning as the Follow Up Boss sync above.
    notifyOpenHouseUpdate(inserted[0].id, {
      agentName: agent.name,
      address: addressTrimmed,
      dateLabel: formatDayLabel(new Date(`${dateValue}T00:00:00Z`)),
      visitorCount: visitorCountNum,
      interestedCount: interestedCountNum,
    });

    res.redirect(`/update/${agent.slug}?submitted=1`);
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
    const { rows: inserted } = await db.query(
      `INSERT INTO entries (agent_id, date, address, buyer_name, buyer_phone, buyer_email, interested, has_agent, buyer_agent_name, feedback)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [agent.id, date, (address || '').trim(), buyerName, buyerPhone || null, buyerEmail || null, interested || 'Maybe', hasAgentBool, hasAgentBool ? ((buyerAgentName || '').trim() || null) : null, feedback || null]
    );
    if (address && address.trim()) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address.trim()]);
    }
    if (!hasAgentBool) {
      // Fire-and-forget: don't make the agent wait on Follow Up Boss (which
      // can take several seconds/retries) before their form submits. The
      // entry is already saved; sync status shows up in the CRM column
      // once it finishes.
      syncEntryToFollowUpBoss(inserted[0].id, {
        agentName: agent.name,
        agentEmail: agent.email,
        buyerName,
        buyerPhone,
        buyerEmail,
        address: (address || '').trim(),
        feedback,
        interested: interested || 'Maybe',
      });
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
    const { rows: existingRows } = await db.query('SELECT fub_synced_at FROM entries WHERE id = $1 AND agent_id = $2', [req.params.id, agent.id]);
    const alreadySynced = existingRows[0] && existingRows[0].fub_synced_at;
    await db.query(
      `UPDATE entries SET date = $1, address = $2, buyer_name = $3, buyer_phone = $4, buyer_email = $5,
       interested = $6, has_agent = $7, buyer_agent_name = $8, feedback = $9 WHERE id = $10 AND agent_id = $11`,
      [date, (address || '').trim(), buyerName, buyerPhone || null, buyerEmail || null, interested || 'Maybe', hasAgentBool, hasAgentBool ? ((buyerAgentName || '').trim() || null) : null, feedback || null, req.params.id, agent.id]
    );
    if (address && address.trim()) {
      await db.query('INSERT INTO houses (address) VALUES ($1) ON CONFLICT (address) DO NOTHING', [address.trim()]);
    }
    if (!hasAgentBool && !alreadySynced) {
      // Fire-and-forget, same reasoning as the create route above.
      syncEntryToFollowUpBoss(req.params.id, {
        agentName: agent.name,
        agentEmail: agent.email,
        buyerName,
        buyerPhone,
        buyerEmail,
        address: (address || '').trim(),
        feedback,
        interested: interested || 'Maybe',
      });
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

// Admin: landing page with 2 options (Open House Feedback / Open House Schedule)
app.get('/admin', (req, res) => {
  res.render('admin-home');
});

// Admin: hub for scheduling-related pages (schedule + house addresses)
app.get('/admin/scheduling', (req, res) => {
  res.render('admin-scheduling');
});

// Admin: all entries across all agents, grouped by house
app.get('/admin/feedback', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT entries.*, agents.name AS agent_name FROM entries
       JOIN agents ON agents.id = entries.agent_id
       ORDER BY date DESC, entries.id DESC`
    );
    const entries = rows.map(mapEntryRow);
    res.render('admin-feedback', { groups: groupByAddress(entries), totalCount: entries.length });
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

// Agent: view + save their own availability for remaining weekend dates
app.get('/agent/:slug/availability', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');

    const dates = getRemainingWeekendDates();
    const { rows } = await db.query('SELECT * FROM availability WHERE agent_id = $1', [agent.id]);
    const existing = new Map(rows.map((r) => [toDateKey(new Date(r.date)), r]));

    const days = dates.map((d) => {
      const key = toDateKey(d);
      const rec = existing.get(key);
      return {
        key,
        label: formatDayLabel(d),
        status: rec ? rec.status : null,
        comment: rec ? (rec.comment || '') : '',
      };
    });

    res.render('availability', { agent, days, saved: req.query.saved === '1' });
  } catch (err) { next(err); }
});

app.post('/agent/:slug/availability', async (req, res, next) => {
  try {
    const { rows: agentRows } = await db.query('SELECT * FROM agents WHERE slug = $1', [req.params.slug]);
    const agent = agentRows[0];
    if (!agent) return res.status(404).render('not-found');

    const dates = getRemainingWeekendDates();
    for (const d of dates) {
      const key = toDateKey(d);
      const checked = req.body[`available_${key}`] === 'on';
      const comment = (req.body[`comment_${key}`] || '').trim();
      const status = checked ? 'Available' : 'Unavailable';
      await db.query(
        `INSERT INTO availability (agent_id, date, status, comment, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (agent_id, date) DO UPDATE SET status = EXCLUDED.status, comment = EXCLUDED.comment, updated_at = now()`,
        [agent.id, key, status, comment || null]
      );
    }
    res.redirect(`/agent/${agent.slug}/availability?saved=1`);
  } catch (err) { next(err); }
});

// Admin: grid of everyone's availability for remaining weekend dates
app.get('/admin/availability', async (req, res, next) => {
  try {
    const agents = (await db.query('SELECT * FROM agents ORDER BY name ASC')).rows;
    const dates = getRemainingWeekendDates();
    const { rows: availRows } = await db.query('SELECT * FROM availability');
    const { rows: noteRows } = await db.query('SELECT * FROM availability_day_notes');

    const availMap = new Map();
    for (const r of availRows) {
      availMap.set(`${r.agent_id}|${toDateKey(new Date(r.date))}`, r);
    }
    const noteMap = new Map(noteRows.map((r) => [toDateKey(new Date(r.date)), r.assignment || '']));

    const days = dates.map((d) => {
      const key = toDateKey(d);
      return {
        key,
        label: formatDayLabel(d),
        assignment: noteMap.get(key) || '',
        cells: agents.map((a) => {
          const rec = availMap.get(`${a.id}|${key}`);
          return { agentName: a.name, status: rec ? rec.status : null, comment: rec ? (rec.comment || '') : '' };
        }),
      };
    });

    res.render('admin-availability', { agents, days, saved: req.query.saved === '1' });
  } catch (err) { next(err); }
});

app.post('/admin/availability', async (req, res, next) => {
  try {
    const dates = getRemainingWeekendDates();
    for (const d of dates) {
      const key = toDateKey(d);
      const assignment = (req.body[`assignment_${key}`] || '').trim();
      await db.query(
        `INSERT INTO availability_day_notes (date, assignment) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET assignment = EXCLUDED.assignment`,
        [key, assignment || null]
      );
    }
    res.redirect('/admin/availability?saved=1');
  } catch (err) { next(err); }
});

// Admin: Open House Schedule (10 fixed slots: house + date + assigned agent)
app.get('/admin/schedule', async (req, res, next) => {
  try {
    const houses = await getHouses();
    const agents = (await db.query('SELECT * FROM agents ORDER BY name ASC')).rows;
    const { rows } = await db.query('SELECT * FROM open_house_schedule ORDER BY slot ASC');
    const bySlot = new Map(rows.map((r) => [r.slot, r]));
    const slots = [];
    for (let i = 1; i <= 10; i++) {
      const rec = bySlot.get(i);
      slots.push({
        slot: i,
        houseAddress: rec ? rec.house_address || '' : '',
        date: rec && rec.date ? formatDateInput(rec.date) : '',
        agentId: rec && rec.agent_id ? rec.agent_id : '',
      });
    }
    res.render('admin-schedule', { houses, agents, slots, saved: req.query.saved === '1' });
  } catch (err) { next(err); }
});

app.post('/admin/schedule', async (req, res, next) => {
  try {
    for (let i = 1; i <= 10; i++) {
      const houseAddress = (req.body[`house_${i}`] || '').trim();
      const date = req.body[`date_${i}`] || null;
      const agentIdRaw = req.body[`agent_${i}`];
      const agentId = agentIdRaw ? parseInt(agentIdRaw, 10) : null;
      await db.query(
        `INSERT INTO open_house_schedule (slot, house_address, date, agent_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slot) DO UPDATE SET house_address = EXCLUDED.house_address, date = EXCLUDED.date, agent_id = EXCLUDED.agent_id`,
        [i, houseAddress || null, date || null, agentId]
      );
    }
    res.redirect('/admin/schedule?saved=1');
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
  migrate()
    .catch((err) => {
      console.error('Database migration failed on startup:', err);
    })
    .finally(() => {
      app.listen(PORT, () => console.log(`Open House Feedback app running on port ${PORT}`));
    });
}

module.exports = app;
