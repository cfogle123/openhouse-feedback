// Sends the "Open House Update" recap (house, visitor count, interested
// count) to Chris and Meredith by email (via Resend) and Slack (via an
// Incoming Webhook). Both are independently optional -- if either isn't
// configured, that half is skipped rather than failing the whole thing, so
// this works even before both integrations are set up.
//
// This file also sends the per-agent "don't forget to submit your update"
// reminder (email via the same Resend setup, Slack via a real 1:1 DM using a
// bot token -- a separate, higher-permission credential than the channel
// webhook above, since posting to an arbitrary person's DM isn't something
// an Incoming Webhook can do).

const RESEND_API_URL = 'https://api.resend.com/emails';
const SLACK_API_URL = 'https://slack.com/api';

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function isSlackConfigured() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

function isSlackBotConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

function recipientEmails() {
  const raw = process.env.OPEN_HOUSE_UPDATE_EMAILS || 'chris@thelistrealty.com,meredith@thelistrealty.com';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function summaryText(update) {
  let text = `${update.agentName} held an open house at ${update.address} on ${update.dateLabel}.\n\n`
    + `Visitors: ${update.visitorCount}\n`
    + `Interested in making an offer: ${update.interestedCount}`;
  if (update.comments) {
    text += `\n\nComments: ${update.comments}`;
  }
  return text;
}

async function sendOpenHouseUpdateEmail(update) {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: 'RESEND_API_KEY not set' };
  }
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const to = recipientEmails();
  const body = {
    from,
    to,
    subject: `Open House Update: ${update.address}`,
    text: summaryText(update),
    html: `<p><strong>${update.agentName}</strong> held an open house at <strong>${update.address}</strong> on ${update.dateLabel}.</p>`
      + `<p>Visitors: <strong>${update.visitorCount}</strong><br>`
      + `Interested in making an offer: <strong>${update.interestedCount}</strong></p>`
      + (update.comments ? `<p>Comments: ${escapeHtml(update.comments)}</p>` : ''),
  };
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Resend request failed (${res.status}): ${text || 'unknown error'}`);
  }
  return { sent: true };
}

async function sendOpenHouseUpdateSlack(update) {
  if (!isSlackConfigured()) {
    return { skipped: true, reason: 'SLACK_WEBHOOK_URL not set' };
  }
  const text = `:house: *Open House Update*\n${summaryText(update)}`;
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`Slack webhook request failed (${res.status}): ${responseText || 'unknown error'}`);
  }
  return { sent: true };
}


function appUrl() {
  return (process.env.APP_URL || 'https://thelistopenhouses.com').replace(/\/$/, '');
}

function reminderSummary(reminder) {
  return `Your open house at ${reminder.address} (${reminder.hours}) on ${reminder.dateLabel} just wrapped up.\n\n`
    + `Don't forget to update Chris & Meredith on how many visitors came by and whether anyone's interested in making an offer:\n`
    + `${appUrl()}/update/${reminder.agentSlug}`;
}

// reminder: { agentName, agentEmail, agentSlug, address, dateLabel, hours }
async function sendReminderEmail(reminder) {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: 'RESEND_API_KEY not set' };
  }
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const body = {
    from,
    to: [reminder.agentEmail],
    subject: `Reminder: recap your open house at ${reminder.address}`,
    text: `Hi ${reminder.agentName},\n\n${reminderSummary(reminder)}`,
    html: `<p>Hi ${escapeHtml(reminder.agentName)},</p>`
      + `<p>Your open house at <strong>${escapeHtml(reminder.address)}</strong> (${escapeHtml(reminder.hours)}) on ${escapeHtml(reminder.dateLabel)} just wrapped up.</p>`
      + `<p>Don't forget to update Chris &amp; Meredith on how many visitors came by and whether anyone's interested in making an offer:</p>`
      + `<p><a href="${appUrl()}/update/${reminder.agentSlug}">${appUrl()}/update/${reminder.agentSlug}</a></p>`,
  };
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Resend request failed (${res.status}): ${text || 'unknown error'}`);
  }
  return { sent: true };
}

// Looks up the agent's Slack user ID from their email, then posts directly
// to them (chat.postMessage with a user ID as the "channel" opens/uses their
// DM automatically -- no separate "open a DM" call needed). Slack's API
// always answers with HTTP 200, even on failure, so success is only real
// when body.ok === true; the body.error string is what actually explains
// what went wrong (e.g. "users_not_found", "missing_scope").
async function sendReminderSlackDM(reminder) {
  if (!isSlackBotConfigured()) {
    return { skipped: true, reason: 'SLACK_BOT_TOKEN not set' };
  }
  const lookupRes = await fetch(`${SLACK_API_URL}/users.lookupByEmail?email=${encodeURIComponent(reminder.agentEmail)}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const lookup = await lookupRes.json();
  if (!lookup.ok) {
    throw new Error(`Slack user lookup failed for ${reminder.agentEmail}: ${lookup.error || 'unknown error'}`);
  }
  const userId = lookup.user.id;

  const text = `:house: *Open House Reminder*\n${reminderSummary(reminder)}`;
  const postRes = await fetch(`${SLACK_API_URL}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: userId, text }),
  });
  const post = await postRes.json();
  if (!post.ok) {
    throw new Error(`Slack DM failed for ${reminder.agentEmail}: ${post.error || 'unknown error'}`);
  }
  return { sent: true };
}

module.exports = {
  sendOpenHouseUpdateEmail,
  sendOpenHouseUpdateSlack,
  isEmailConfigured,
  isSlackConfigured,
  isSlackBotConfigured,
  sendReminderEmail,
  sendReminderSlackDM,
};
