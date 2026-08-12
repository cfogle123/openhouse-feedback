// Sends the "Open House Update" recap (house, visitor count, interested
// count) to Chris and Meredith by email (via Resend) and Slack (as a direct
// 1:1 DM to each of them), plus the per-agent "don't forget to submit your
// update" reminder (email + a Slack DM to that agent). Both channels are
// independently optional -- if either isn't configured, that half is
// skipped rather than failing the whole thing.
//
// Slack delivery for both features uses a bot token (SLACK_BOT_TOKEN), not
// an Incoming Webhook -- a webhook can only post into one fixed channel, it
// has no way to message an arbitrary person's DM. SLACK_WEBHOOK_URL is no
// longer used anywhere in this app.

const RESEND_API_URL = 'https://api.resend.com/emails';
const SLACK_API_URL = 'https://slack.com/api';

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
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

// Looks up a Slack user ID from their email, then posts directly to them
// (chat.postMessage with a user ID as the "channel" opens/uses their DM
// automatically -- no separate "open a DM" call needed). Slack's API always
// answers with HTTP 200, even on failure, so success is only real when
// body.ok === true; body.error is what actually explains what went wrong
// (e.g. "users_not_found", "missing_scope").
async function sendSlackDMByEmail(email, text) {
  const lookupRes = await fetch(`${SLACK_API_URL}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const lookup = await lookupRes.json();
  if (!lookup.ok) {
    throw new Error(`Slack user lookup failed for ${email}: ${lookup.error || 'unknown error'}`);
  }
  const postRes = await fetch(`${SLACK_API_URL}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: lookup.user.id, text }),
  });
  const post = await postRes.json();
  if (!post.ok) {
    throw new Error(`Slack DM failed for ${email}: ${post.error || 'unknown error'}`);
  }
}

// DMs every recipient in recipientEmails() (Chris & Meredith by default)
// individually. Succeeds only if every recipient's DM succeeds; if any fail,
// throws one combined error naming each failure so slack_error on the
// open_house_updates row shows exactly who didn't get it and why.
async function sendOpenHouseUpdateSlack(update) {
  if (!isSlackBotConfigured()) {
    return { skipped: true, reason: 'SLACK_BOT_TOKEN not set' };
  }
  const text = `:house: *Open House Update*\n${summaryText(update)}`;
  const errors = [];
  for (const email of recipientEmails()) {
    try {
      await sendSlackDMByEmail(email, text);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) {
    throw new Error(errors.join(' | '));
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

async function sendReminderSlackDM(reminder) {
  if (!isSlackBotConfigured()) {
    return { skipped: true, reason: 'SLACK_BOT_TOKEN not set' };
  }
  const text = `:house: *Open House Reminder*\n${reminderSummary(reminder)}`;
  await sendSlackDMByEmail(reminder.agentEmail, text);
  return { sent: true };
}

module.exports = {
  sendOpenHouseUpdateEmail,
  sendOpenHouseUpdateSlack,
  isEmailConfigured,
  isSlackBotConfigured,
  sendReminderEmail,
  sendReminderSlackDM,
};
