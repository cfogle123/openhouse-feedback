// Sends the "Open House Update" recap (house, visitor count, interested
// count) to Chris and Meredith by email (via Resend) and Slack (via an
// Incoming Webhook). Both are independently optional -- if either isn't
// configured, that half is skipped rather than failing the whole thing, so
// this works even before both integrations are set up.

const RESEND_API_URL = 'https://api.resend.com/emails';

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function isSlackConfigured() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

function recipientEmails() {
  const raw = process.env.OPEN_HOUSE_UPDATE_EMAILS || 'chris@thelistrealty.com,meredith@thelistrealty.com';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function summaryText(update) {
  return `${update.agentName} held an open house at ${update.address} on ${update.dateLabel}.\n\n`
    + `Visitors: ${update.visitorCount}\n`
    + `Interested in making an offer: ${update.interestedCount}`;
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
      + `Interested in making an offer: <strong>${update.interestedCount}</strong></p>`,
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

module.exports = { sendOpenHouseUpdateEmail, sendOpenHouseUpdateSlack, isEmailConfigured, isSlackConfigured };
