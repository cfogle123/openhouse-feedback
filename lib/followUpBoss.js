// Sends open-house visitors who don't have their own buyer's agent into
// Follow Up Boss as a new/deduped person, tagged "Open House" and assigned
// to the agent who logged them.
//
// Uses POST /v1/events (the FUB-documented way to send in leads so dedup +
// contact history work correctly), then PUT /v1/people/:id?mergeTags=true
// to set the tag (merged with any tags already on the contact, per FUB's
// own mergeTags option, rather than overwriting them) and the assignment.
//
// FUB can take a moment to finish indexing a person right after an /events
// call creates them, so if the tag doesn't come back in the PUT response
// we retry once after a short delay before giving up and reporting a
// real error (rather than silently claiming success).

const FUB_BASE = 'https://api.followupboss.com/v1';
const FUB_TAG = 'Open House';

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

async function tagAndAssign(personId, agentName) {
  const updated = await fubRequest(`/people/${personId}?mergeTags=true`, {
    method: 'PUT',
    body: JSON.stringify({
      tags: [FUB_TAG],
      assignedTo: agentName,
    }),
  });
  return Boolean(updated && Array.isArray(updated.tags) && updated.tags.includes(FUB_TAG));
}

// entry: { agentName, buyerName, buyerPhone, buyerEmail, address, feedback, interested }
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
    // Lead was accepted but we didn't get a person id back (e.g. lead flow
    // archived, returns 204). Nothing more we can do to tag/assign.
    return { synced: true, tagged: false };
  }

  let tagged = await tagAndAssign(personId, entry.agentName);
  if (!tagged) {
    // FUB may still be indexing the just-created person. Wait and retry once.
    await sleep(1500);
    tagged = await tagAndAssign(personId, entry.agentName);
  }

  if (!tagged) {
    const err = new Error(
      `Follow Up Boss accepted the lead (person ${personId}) but did not apply the "${FUB_TAG}" tag after two attempts.`
    );
    err.personId = personId;
    throw err;
  }

  return { synced: true, tagged: true, personId };
}

module.exports = { sendOpenHouseLead, isConfigured };
