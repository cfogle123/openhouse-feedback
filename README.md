# Open House Feedback — The List Realty

A simple internal site for agents to log open house visitors and feedback, replacing the shared spreadsheet. Each agent gets their own page (no login needed — just pick your name); there's also an "All Entries" admin view with CSV export, a house address list, a "Browse by house" view with bulk delete, and an availability tracker.

## Tech stack

Plain Node.js + Express + EJS templates + PostgreSQL (via the `pg` package).

## Local setup

```bash
npm install
cp .env.example .env   # then paste your DATABASE_URL into .env
npm run seed
npm start
```

Visit http://localhost:3000

## Follow Up Boss sync (optional)

When enabled, any visitor logged by an agent WITHOUT their own buyer's agent is automatically sent into Follow Up Boss as a new (or matched/deduped) person, tagged **"Open House"**, and assigned to the agent who logged them.

To turn it on, add these environment variables (on Render, under your service → Environment):

- `FUB_API_KEY` — a Follow Up Boss API key. Log into Follow Up Boss as an admin → gear/Admin icon → **API** → create a key.
- `FUB_SYSTEM_NAME` — optional, defaults to `The List Open Houses`.
- `FUB_SOURCE_NAME` — optional, defaults to `thelistopenhouses.com`.

Leave `FUB_API_KEY` unset to keep this feature off — everything else works the same either way.

Each entry's sync status ("Synced" / "Sync failed" / "Pending") shows in the **CRM** column on the All Entries admin page and the Browse-by-house page, for visitors without their own agent.

## Slack setup (shared by both features below)

Both the Open House Update notification and the open-house reminders use a Slack **bot token** to send real 1:1 direct messages -- not an Incoming Webhook, since a webhook can only post into one fixed channel and has no way to message an arbitrary person.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch** (skip this step if you already made an app previously).
2. Name it, pick your workspace.
3. In the left sidebar, click **OAuth & Permissions**.
4. Scroll to **Bot Token Scopes** → **Add an OAuth Scope** → add both `chat:write` and `users:read.email`.
5. Scroll up, click **Install to Workspace** (or **Reinstall to Workspace** if you've installed it before) → **Allow**.
6. Copy the **Bot User OAuth Token** near the top of that page (starts with `xoxb-`).
7. Add it as `SLACK_BOT_TOKEN`.

Every agent (and Chris/Meredith) needs to be a member of the Slack workspace under the same email address that's in this app, since that's how a message gets matched to the right person.

## Open House Update notifications (optional)

The **Open House Update** box on the home page lets an agent recap an open house (house, visitor count, how many are interested in making an offer) and send it straight to Chris and Meredith by email and a direct Slack message to each of them.

To turn on email, add:

- `RESEND_API_KEY` — an API key from [resend.com](https://resend.com) (free tier is fine). Sign up, verify a sending domain (or just use the sandbox address while testing), then create an API key under **API Keys**.
- `RESEND_FROM_EMAIL` — optional, defaults to Resend's sandbox address `onboarding@resend.dev`. Set this to an address on your verified domain once you've set one up in Resend.
- `OPEN_HOUSE_UPDATE_EMAILS` — optional, defaults to `chris@thelistrealty.com,meredith@thelistrealty.com`. Comma-separated list of who receives it (used for both email and the Slack DMs).

Slack uses the same `SLACK_BOT_TOKEN` described above -- no separate setup needed once that's in place.

Both channels are independently optional -- leave either unconfigured to skip that half. The update is always saved either way, even if both are left off.

## Open house reminder emails/DMs (optional)

Five minutes after a scheduled open house's time slot ends (per the **Open House Schedule** admin page), the assigned agent gets a reminder by email and a direct Slack message, nudging them to fill out their Open House Update.

Because Render's free plan sleeps the app when nothing's hitting it, this can't run on an internal timer alone -- an external service has to ping the app on a schedule to trigger the check. That ping doubles as what keeps the reminder logic actually running.

**1. Reuse the existing Resend setup above for email** -- no extra step if `RESEND_API_KEY` is already set.

**2. Reuse the same `SLACK_BOT_TOKEN` from the Slack setup above** -- no extra step needed.

**3. Set a secret to protect the trigger endpoint:**

- `REMINDER_CRON_SECRET` — any random string you pick (doesn't come from anywhere else, you're inventing it). Anyone hitting `/internal/reminders/run` without the matching `?secret=...` gets rejected, so this just needs to be hard to guess.
- `APP_URL` — optional, defaults to `https://thelistopenhouses.com`. Used to build the link in the reminder to the agent's update form.

**4. Set up the external ping** (free, at [cron-job.org](https://cron-job.org)):
  1. Sign up for a free account.
  2. Create a new cron job with URL: `https://thelistopenhouses.com/internal/reminders/run?secret=YOUR_SECRET_HERE`
  3. Set it to run every 5 minutes.
  4. Save and enable it.

Resend and the cron ping are each independently optional -- whichever aren't configured are just skipped, same pattern as the Open House Update notifications above. The Slack bot token is shared with the Open House Update feature, so once it's set up once, both features can use it.

## Visitor Sign-In kiosk PIN (optional but recommended)

The Visitor Sign-In kiosk (`/signin`) is meant to be left sitting out on a phone or tablet at an open house, so anyone who walks up to it -- or just types the URL -- could otherwise use it. Setting `SIGNIN_PIN` puts a simple PIN screen in front of the whole flow.

- `SIGNIN_PIN` -- any PIN or short password you pick (not something that comes from another service, you're just inventing a shared code). Share it only with whoever should be able to run the kiosk.
- Until `SIGNIN_PIN` is set in Render, the sign-in flow is locked for everyone (including you) -- there's no PIN to match yet. Set it before you need to use the kiosk.
- Once someone enters the correct PIN on a device, that device stays unlocked for 6 months (via a cookie), so it doesn't need re-entering every open house.
- To change the PIN later, just update `SIGNIN_PIN` in Render -- anyone still using the old PIN's cookie will be prompted again next time.

## Scan Feedback Form (optional)

On the agent entry page, the "Scan Feedback Form" button next to Add Entry lets an agent take a photo of a paper feedback form and have it read automatically into the Log New Entry fields (buyer name, phone, email, interested, agent info, notes) for review before saving -- nothing is saved straight from the photo, it just pre-fills the normal form.

This reads the photo using Anthropic's API (Claude), since that's the best fit for reading handwriting off a photo.

1. Go to [console.anthropic.com](https://console.anthropic.com), create an account if you don't have one, and generate an API key.
2. In Render, add environment variable `ANTHROPIC_API_KEY` with that key.
3. That's it -- the button appears automatically once the key is set. Without it, clicking the button shows a message asking to set it up, rather than failing silently.

Each scan costs a small amount (a fraction of a cent to a few cents depending on photo size) billed to your Anthropic account -- there's no separate subscription, just pay-as-you-go for what you actually scan.
