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
// If an agent's email doesn't resolve to a Follow Up Boss user (wrong/no
// account, API hiccup, etc.), we still apply the tag rather than failing
// the whole sync — but we record WHY assignment didn't happen so it's
// visible in the CRM column instead of silently landing on whichever
// agent Follow Up Boss's Lead Flow defaults to.
//
// FUB can also take a moment to finish indexing a person right after an
// /events call creates them, so if the tag doesn't come back in the PUT
// response we retry with increasing delays before giving up and reporting
// a real error (rather than silently claiming success).
//
// --- Duplicate-vs-reassign handling ---------------------------------
// /events dedups by matching the buyer's email/phone against existing
// Follow Up Boss people, then updates whichever person it finds. Left on
// its own, that means: if Agent A already has this buyer in FUB and Agent
// B later logs the same buyer, /events would find Agent A's person and we'd
// reassign it to Agent B — silently taking the lead away from Agent A.
// That's not what the team wants. Instead: before syncing, we look up
// whether this buyer already exists in FUB and who owns it.
//   - No existing person, or it's owned by the SAME agent who's logging
//     this entry: proceed as before (via /events, update-or-create).
//   - Owned by a DIFFERENT agent: create a brand-new person instead
//     (via POST /people, which does NOT dedup) so the new entry lands
//     under the logging agent without touching the other agent's contact.
//     A duplicate person in FUB is expected/acceptable in this case.
// If the lookup itself fails or comes back ambiguous, we fall back to the
// original /events behavior rather than blocking the sync.

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

// Cache email -> { id, reason }, but ONLY when a real match was found.
// A confirmed match is safe to reuse for the life of the process (user ids
// don't change). A "no match" or lookup error is NOT cached — it could be
// a transient API hiccup, and caching it would permanently stick an agent
// as "unassignable" for as long as the server stays up, even if a later
// lookup (including a later retry attempt for the same entry) would have
// succeeded.
const userIdCache = new Map();

async function resolveAssignedUserId(email) {
  if (!email) return { id: null, reason: 'this agent has no email on file' };
  const key = email.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);
  let result;
  try {
    const data = await fubRequest(`/users?email=${encodeURIComponent(email)}&fields=id,name`, { method: 'GET' });
    const list = (data && (data.users || (data._embedded && data._embedded.users))) || (Array.isArray(data) ? data : []);
    if (Array.isArray(list) && list.length > 0 && list[0].id) {
      result = { id: list[0].id, reason: null };
      userIdCache.set(key, result); // only cache confirmed matches
    } else {
      result = { id: null, reason: `no Follow Up Boss user is registered with the email ${email}` };
    }
  } catch (e) {
    result = { id: null, reason: `error looking up the Follow Up Boss user for ${email}: ${e.message}` };
  }
  return result;
}

// Looks up whether this buyer already exists in Follow Up Boss (by email,
// falling back to phone) and, if so, who currently owns that contact. This
// is purely advisory — a miss, an API error, or an unexpected response
// shape all just resolve to "no existing person found," which falls
// through to the normal /events dedup-and-update behavior. That's the
// same failure mode a not-yet-verified search integration should have:
// worst case it behaves exactly like it did before this change.
async function findExistingPerson(entry) {
  const query = entry.buyerEmail || entry.buyerPhone;
  if (!query) return null;
  try {
    const data = await fubRequest(`/people?q=${encodeURIComponent(query)}&fields=id,assignedUserId,assignedTo`, { method: 'GET' });
    const list = (data && (data.people || (data._embedded && data._embedded.people))) || (Array.isArray(data) ? data : []);
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  } catch (e) {
    console.warn('Follow Up Boss: existing-person lookup failed, proceeding as if none was found:', e.message);
    return null;
  }
}

async function applyTagAndAssignment(personId, agentEmail) {
  const body = { tags: [FUB_TAG] };
  const { id: userId, reason: unassignedReason } = await resolveAssignedUserId(agentEmail);
  if (userId) {
    body.assignedUserId = userId;
  }
  await fubRequest(`/people/${personId}?mergeTags=true`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return { assigned: Boolean(userId), unassignedReason: userId ? null : unassignedReason };
}

// Don't trust the PUT response body for confirmation (it may not echo back
// the full field set) — look the person back up with a dedicated GET so we
// know for certain whether the tag actually landed.
async function verifyTagged(personId) {
  const person = await fubRequest(`/people/${personId}?fields=id,tags`, { method: 'GET' });
  return Boolean(person && Array.isArray(person.tags) && person.tags.includes(FUB_TAG));
}

// A person that /events (or the direct /people create, below) just made
// can take a few seconds to finish indexing on Follow Up Boss's side
// before writes to it reliably stick, so we retry with increasing delays
// rather than giving up after one attempt.
async function ensureTaggedAndAssigned(personId, agentEmail) {
  const delaysMs = [0, 2000, 4000];
  let assigned = false;
  let unassignedReason = null;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt]) await sleep(delaysMs[attempt]);
    const result = await applyTagAndAssignment(personId, agentEmail);
    assigned = result.assigned;
    unassignedReason = result.unassignedReason;
    if (await verifyTagged(personId)) {
      return { tagged: true, assigned, unassignedReason };
    }
  }
  return { tagged: false, assigned, unassignedReason };
}

function buildMessage(entry) {
  const messageParts = [`Visited open house at ${entry.address || 'an open house'}.`];
  if (entry.interested) messageParts.push(`Interest level: ${entry.interested}.`);
  if (entry.feedback) messageParts.push(`Feedback: ${entry.feedback}`);
  if (entry.homeAddress) messageParts.push(`Current home address: ${entry.homeAddress}.`);
  if (entry.ownsOrRents) messageParts.push(`${entry.ownsOrRents === 'Own' ? 'Owns' : 'Rents'} their current home.`);
  if (entry.wantsOffMarketInfo === true) messageParts.push('Interested in hearing about off-market listings.');
  return messageParts.join(' ');
}

// Normal path: let Follow Up Boss dedup by email/phone via /events, which
// creates a new person (or finds/updates the existing one) and logs the
// visit as an activity on it.
async function createOrUpdateViaEvents(entry, person, message) {
  const eventData = await fubRequest('/events', {
    method: 'POST',
    body: JSON.stringify({
      source: process.env.FUB_SOURCE_NAME || 'thelistopenhouses.com',
      system: process.env.FUB_SYSTEM_NAME || 'The List Open Houses',
      type: 'Visited Open House',
      message,
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
  return personId;
}

// Duplicate path: create a standalone person directly via POST /people
// (no dedup), then best-effort attach a note with the same visit details
// /events would have logged as an activity. The note is non-fatal — if it
// fails, the duplicate person still exists and still gets tagged/assigned
// below, it just won't have the note text attached.
async function createDuplicatePerson(person, message) {
  const created = await fubRequest('/people', {
    method: 'POST',
    body: JSON.stringify({ ...person, tags: [FUB_TAG] }),
  });
  const personId = created && created.id;
  if (!personId) {
    throw new Error('Follow Up Boss accepted the duplicate-person request but returned no person id.');
  }
  try {
    await fubRequest('/notes', {
      method: 'POST',
      body: JSON.stringify({ personId, subject: 'Visited Open House', body: message }),
    });
  } catch (e) {
    console.warn(`Follow Up Boss: created duplicate person ${personId} but the visit note failed to attach: ${e.message}`);
  }
  return personId;
}

// entry: { agentName, agentEmail, buyerName, buyerPhone, buyerEmail, address,
//          feedback, interested, homeAddress, ownsOrRents, wantsOffMarketInfo }
// The last three are only ever populated by the visitor self-sign-in kiosk;
// the agent feedback form doesn't collect them, so they're simply absent
// (and skipped below) on those entries.
async function sendOpenHouseLead(entry) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'FUB_API_KEY not set' };
  }

  const { firstName, lastName } = splitName(entry.buyerName);
  const person = { firstName, lastName };
  if (entry.buyerEmail) person.emails = [{ value: entry.buyerEmail }];
  if (entry.buyerPhone) person.phones = [{ value: entry.buyerPhone }];

  const message = buildMessage(entry);

  // Figure out who's logging this entry (in Follow Up Boss terms) so we can
  // compare against whoever already owns this buyer, if anyone does.
  const { id: enteringAgentUserId } = await resolveAssignedUserId(entry.agentEmail);
  const existing = await findExistingPerson(entry);
  const existingOwnerId = existing && existing.assignedUserId ? existing.assignedUserId : null;
  // Only force a duplicate when we're confident about BOTH sides of the
  // comparison (a resolved id for the logging agent, and a resolved owner
  // on the existing person) and they disagree. Any uncertainty (no existing
  // person, existing person unassigned, or we couldn't resolve the logging
  // agent's Follow Up Boss user) falls back to the original update behavior.
  const forceNewPerson = Boolean(existing && enteringAgentUserId && existingOwnerId && existingOwnerId !== enteringAgentUserId);

  const personId = forceNewPerson
    ? await createDuplicatePerson(person, message)
    : await createOrUpdateViaEvents(entry, person, message);

  const result = await ensureTaggedAndAssigned(personId, entry.agentEmail);

  if (!result.tagged) {
    const err = new Error(
      `Follow Up Boss accepted the lead (person ${personId}) but the "${FUB_TAG}" tag still wasn't confirmed after 3 attempts over ~6 seconds.`
    );
    err.personId = personId;
    throw err;
  }

  if (!result.assigned) {
    console.warn(`Follow Up Boss: tagged person ${personId} "${FUB_TAG}" but ${result.unassignedReason || 'could not resolve an assignee'}.`);
  }

  return {
    synced: true,
    tagged: true,
    assigned: result.assigned,
    unassignedReason: result.unassignedReason,
    personId,
    duplicateCreated: forceNewPerson,
  };
}

module.exports = { sendOpenHouseLead, isConfigured };
