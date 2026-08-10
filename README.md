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
