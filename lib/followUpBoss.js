// Sends open-house visitors who don't have their own buyer's agent into
// Follow Up Boss as a new/deduped person, tagged "Open House" and assigned
// to the agent who logged them.
//
// Uses POST /v1/events (the FUB-documented way to send in leads so dedup +
// contact history work correctly), then PUT /v1/people/:id?mergeTags=true
// to set the tag (merged with any tags already on the contact, per FUB's
// own mergeTags option, rather than overwriting them) and the assignment.
//
// Assignment uses assignedUserId (looked up from the agent's email via
// GET /users) instead of assignedTo (a free-text full-name match) because
// FUB rejects the *entire* update — tag included — if assignedTo doesn't
// exactly match an existing user's full name. Resolving by email is far
// more reliable since our agent list's emails are the same addresses used
// to log into Follow Up Boss.
//
// FUB can also take a moment to finish indexing a person right after an
// /events call creates them, so if the tag doesn't come back in the PUT
// response we retry once after a short delay before giving up and
// reporting a real error (rather than silently claiming success).

const FUB_BASE = 'https://api.followupboss.com/v1';
// Matches the tag your team already uses in Follow Up Boss ("open house",
// 265 uses as of Aug 2026) rather than creating a new, differently-cased
// tag value. Override with FUB_TAG_NAME if you ever want a different tag.
const FUB_TAG = process.env.FUB_TAG_NAME || 'open house';

function isConfigured() {
  return Boolean(process.env.FUB_API_KEY);
}

function authHeader() {
  const token = Buffer.from(`${process.env.FUB_API_KEY}:`).toString('base64');
  return `Basic ${token}`;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Open House', lastName: 'Visitor' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fubRequest(path, options) {
  const res = await fetch(`${FUB_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON response */ }
  if (!res.ok) {
    const detail = data && (data.errorMessage || data.error) ? (data.errorMessage || data.error) : text;
    const err = new Error(`Follow Up Boss ${path} failed (${res.status}): ${detail || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cache email -> Follow Up Boss user id for the life of the process, so we
// don't re-look-up the same 10 agents on every single form submission.
const userIdCache = new Map();

async function resolveAssignedUserId(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);
  let id = null;
  try {
    const data = await fubRequest(`/users?email=${encodeURIComponent(email)}&fields=id,name`, { method: 'GET' });
    const list = (data && (data.users || (data._embedded && data._embedded.users))) || (Array.isArray(data) ? data : []);
    if (Array.isArray(list) && list.length > 0 && list[0].id) {
      id = list[0].id;
    }
  } catch (e) {
    // Treat lookup failure as "no match" rather than blowing up the sync.
    id = null;
  }
  userIdCache.set(key, id);
  return id;
}

async function applyTagAndAssignment(personId, agentEmail) {
  const body = { tags: [FUB_TAG] };
  const userId = await resolveAssignedUserId(agentEmail);
  if (userId) {
    body.assignedUserId = userId;
  }
  await fubRequest(`/people/${personId}?mergeTags=true`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return { assigned: Boolean(userId) };
}

// Don't trust the PUT response body for confirmation (it may not echo back
// the full field set) — look the person back up with a dedicated GET so we
// know for certain whether the tag actually landed.
async function verifyTagged(personId) {
  const person = await fubRequest(`/people/${personId}?fields=id,tags`, { method: 'GET' });
  return Boolean(person && Array.isArray(person.tags) && person.tags.includes(FUB_TAG));
}

// A person that /events just created can take a few seconds to finish
// indexing on Follow Up Boss's side before writes to it reliably stick, so
// we retry with increasing delays rather than giving up after one attempt.
async function ensureTaggedAndAssigned(personId, agentEmail) {
  const delaysMs = [0, 2000, 4000];
  let assigned = false;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt]) await sleep(delaysMs[attempt]);
    const result = await applyTagAndAssignment(personId, agentEmail);
    assigned = result.assigned;
    if (await verifyTagged(personId)) {
      return { tagged: true, assigned };
    }
  }
  return { tagged: false, assigned };
}

// entry: { agentName, agentEmail, buyerName, buyerPhone, buyerEmail, address, feedback, interested }
async function sendOpenHouseLead(entry) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'FUB_API_KEY not set' };
  }

  const { firstName, lastName } = splitName(entry.buyerName);
  const person = { firstName, lastName };
  if (entry.buyerEmail) person.emails = [{ value: entry.buyerEmail }];
  if (entry.buyerPhone) person.phones = [{ value: entry.buyerPhone }];

  const messageParts = [`Visited open house at ${entry.address || 'an open house'}.`];
  if (entry.interested) messageParts.push(`Interest level: ${entry.interested}.`);
  if (entry.feedback) messageParts.push(`Feedback: ${entry.feedback}`);

  const eventData = await fubRequest('/events', {
    method: 'POST',
    body: JSON.stringify({
      source: process.env.FUB_SOURCE_NAME || 'thelistopenhouses.com',
      system: process.env.FUB_SYSTEM_NAME || 'The List Open Houses',
      type: 'Visited Open House',
      message: messageParts.join(' '),
      person,
    }),
  });

  const personId = eventData && eventData.id;
  if (!personId) {
    // Follow Up Boss returns 204/no body when the Lead Flow tied to this
    // source has been archived, meaning the event was silently ignored and
    // NO person was created. That's a real failure, not a success — make
    // sure it shows up as "Sync failed" instead of a false "Synced".
    throw new Error(
      'Follow Up Boss accepted the request but returned no person (this usually means the Lead Flow for source '
      + `"${process.env.FUB_SOURCE_NAME || 'thelistopenhouses.com'}" has been archived/disabled in Follow Up Boss `
      + 'Admin → Lead Flow — check there).'
    );
  }

  const result = await ensureTaggedAndAssigned(personId, entry.agentEmail);

  if (!result.tagged) {
    const err = new Error(
      `Follow Up Boss accepted the lead (person ${personId}) but the "${FUB_TAG}" tag still wasn't confirmed after 3 attempts over ~6 seconds.`
    );
    err.personId = personId;
    throw err;
  }

  if (!result.assigned) {
    console.warn(
      `Follow Up Boss: tagged person ${personId} "${FUB_TAG}" but could not find a Follow Up Boss user for ${entry.agentEmail || '(no email)'}; left unassigned.`
    );
  }

  return { synced: true, tagged: true, assigned: result.assigned, personId };
}

module.exports = { sendOpenHouseLead, isConfigured };
