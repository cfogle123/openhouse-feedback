// Figures out which scheduled open houses have wrapped up (end time + 5
// minutes has passed) but haven't had their "update Chris & Meredith"
// reminder sent yet, and sends it (email + Slack DM). Triggered by an
// external cron-style ping hitting a protected route in server.js, since
// the app itself can't reliably run its own background timer on Render's
// free tier (the instance sleeps when nothing's hitting it).

const db = require('../db');
const {
  isEmailConfigured,
  isSlackBotConfigured,
  sendReminderEmail,
  sendReminderSlackDM,
} = require('./notifications');

// Only the two fixed windows the schedule page's dropdown offers. Free-text
// in the DB (see schema.sql's comment on open_house_schedule.hours) but
// constrained to exactly these two values by the dropdown itself, so a
// simple lookup is enough here.
const HOURS_END_TIME = {
  '1:00 PM - 3:00 PM EST': { hour: 15, minute: 0 },
  '5:00 PM - 7:00 PM EST': { hour: 19, minute: 0 },
};

const REMINDER_DELAY_MINUTES = 5;
// If the reminder mechanism was down (cron-job.org paused, Render outage,
// etc.) for longer than this, stop trying to send increasingly-late
// reminders for old slots -- just mark them as skipped instead of emailing
// someone about an open house from three days ago.
const MAX_REMINDER_AGE_MS = 24 * 60 * 60 * 1000;

// Converts a wall-clock date + hour/minute in America/New_York (handles EST
// vs EDT automatically) into the equivalent UTC Date. Uses a one-shot
// "guess and correct" trick: interpret the target wall time as if it were
// UTC, see what that instant actually displays as in America/New_York, then
// shift by the difference. This works in a single pass because the
// Eastern/UTC offset doesn't change within the few hours this can be off by.
function easternWallTimeToUtc(dateStr, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const guessUtc = new Date(`${dateStr}T${hh}:${mm}:00Z`);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(guessUtc).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // formatToParts can return "24" for midnight with hour12:false; normalize.
  const shownHour = parts.hour === '24' ? '00' : parts.hour;
  const shownAsIfUtc = new Date(`${parts.year}-${parts.month}-${parts.day}T${shownHour}:${parts.minute}:${parts.second}Z`);
  const target = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  const diffMs = target.getTime() - shownAsIfUtc.getTime();
  return new Date(guessUtc.getTime() + diffMs);
}

// Returns the UTC Date the reminder should fire at, or null if `hours`
// isn't one of the two known slot labels.
function getReminderTriggerUtc(dateStr, hours) {
  const end = HOURS_END_TIME[hours];
  if (!end || !dateStr) return null;
  let minute = end.minute + REMINDER_DELAY_MINUTES;
  let hour = end.hour;
  if (minute >= 60) {
    minute -= 60;
    hour += 1;
  }
  return easternWallTimeToUtc(dateStr, hour, minute);
}

function formatDayLabelUtc(dateStr) {
  // dateStr is a plain YYYY-MM-DD; format it the same way the rest of the
  // app does for dates, without importing server.js (would create a
  // require cycle since server.js requires this file).
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Finds slots with at least one still-pending channel (email and/or Slack)
// and attempts just that channel. Each channel settles independently --
// once email succeeds, it's marked done and is never touched again on this
// slot, no matter what happens with Slack (and vice versa). This is the fix
// for a real bug: the original version only marked a slot "sent" once BOTH
// channels succeeded, so a persistently-failing Slack DM meant the working
// email kept resending on every single 5-minute cron check, forever.
async function runDueReminders(now = new Date()) {
  const emailOn = isEmailConfigured();
  const slackOn = isSlackBotConfigured();
  if (!emailOn && !slackOn) {
    return { skipped: true, reason: 'Neither RESEND_API_KEY nor SLACK_BOT_TOKEN is set', processed: [] };
  }

  // Deliberately not a JOIN -- pg-mem's test harness can't handle a JOIN
  // combined with parameterized booleans in an OR'd WHERE clause (confirmed
  // separately; the same WHERE works fine against a single table). Real
  // Postgres has no such limitation, but fetching agents separately and
  // mapping by id in JS sidesteps it for testing, and the agents table is
  // tiny (10 rows) so this isn't meaningfully less efficient anyway.
  const { rows: scheduleRows } = await db.query(
    `SELECT slot, house_address, date, hours, agent_id,
            reminder_email_sent_at, reminder_slack_sent_at
     FROM open_house_schedule
     WHERE (
         ($1 AND reminder_email_sent_at IS NULL)
         OR ($2 AND reminder_slack_sent_at IS NULL)
       )
       AND house_address IS NOT NULL AND house_address != ''
       AND date IS NOT NULL
       AND hours IS NOT NULL AND hours != ''`,
    [emailOn, slackOn]
  );
  const { rows: agentRows } = await db.query('SELECT id, name, email, slug FROM agents');
  const agentsById = new Map(agentRows.map((a) => [a.id, a]));
  const rows = scheduleRows
    .map((r) => {
      const agent = agentsById.get(r.agent_id);
      if (!agent) return null;
      return { ...r, agent_name: agent.name, agent_email: agent.email, agent_slug: agent.slug };
    })
    .filter(Boolean);

  const processed = [];
  for (const row of rows) {
    const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
    const triggerAt = getReminderTriggerUtc(dateStr, row.hours);
    if (!triggerAt) {
      processed.push({ slot: row.slot, status: 'skipped', reason: `unrecognized hours value "${row.hours}"` });
      continue;
    }
    if (now < triggerAt) {
      processed.push({ slot: row.slot, status: 'not-due-yet', triggerAt: triggerAt.toISOString() });
      continue;
    }

    const tooOld = now - triggerAt > MAX_REMINDER_AGE_MS;
    const reminder = {
      agentName: row.agent_name,
      agentEmail: row.agent_email,
      agentSlug: row.agent_slug,
      address: row.house_address,
      dateLabel: formatDayLabelUtc(dateStr),
      hours: row.hours,
    };
    const result = { slot: row.slot };

    const emailPending = emailOn && !row.reminder_email_sent_at;
    if (emailPending) {
      if (tooOld) {
        await db.query(
          'UPDATE open_house_schedule SET reminder_email_sent_at = now(), reminder_email_error = $2 WHERE slot = $1',
          [row.slot, 'Skipped: reminder became due more than 24 hours ago before this ran']
        );
        result.email = 'skipped-too-old';
      } else {
        try {
          await sendReminderEmail(reminder);
          await db.query(
            'UPDATE open_house_schedule SET reminder_email_sent_at = now(), reminder_email_error = NULL WHERE slot = $1',
            [row.slot]
          );
          result.email = 'sent';
        } catch (err) {
          await db.query('UPDATE open_house_schedule SET reminder_email_error = $2 WHERE slot = $1', [row.slot, String(err.message).slice(0, 500)]);
          result.email = 'error';
          result.emailError = err.message;
        }
      }
    } else {
      result.email = !emailOn ? 'not-configured' : 'already-settled';
    }

    const slackPending = slackOn && !row.reminder_slack_sent_at;
    if (slackPending) {
      if (tooOld) {
        await db.query(
          'UPDATE open_house_schedule SET reminder_slack_sent_at = now(), reminder_slack_error = $2 WHERE slot = $1',
          [row.slot, 'Skipped: reminder became due more than 24 hours ago before this ran']
        );
        result.slack = 'skipped-too-old';
      } else {
        try {
          await sendReminderSlackDM(reminder);
          await db.query(
            'UPDATE open_house_schedule SET reminder_slack_sent_at = now(), reminder_slack_error = NULL WHERE slot = $1',
            [row.slot]
          );
          result.slack = 'sent';
        } catch (err) {
          await db.query('UPDATE open_house_schedule SET reminder_slack_error = $2 WHERE slot = $1', [row.slot, String(err.message).slice(0, 500)]);
          result.slack = 'error';
          result.slackError = err.message;
        }
      }
    } else {
      result.slack = !slackOn ? 'not-configured' : 'already-settled';
    }

    processed.push(result);
  }

  return { skipped: false, processed };
}

module.exports = { runDueReminders, getReminderTriggerUtc, easternWallTimeToUtc };
