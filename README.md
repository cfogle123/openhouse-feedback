# Open House Feedback — The List Realty

A simple internal site for agents to log open house visitors and feedback, replacing the shared spreadsheet. Each agent gets their own page (no login needed — just pick your name); there's also an "All Entries" admin view with CSV export.

## What's included

- Home page: pick your name from a grid of agents
- Agent page: a form (Date, Address, Buyer Name/Phone/Email, Interested Y/N/Maybe, has-own-agent checkbox, Feedback/Notes) plus a table of that agent's own past entries, with edit and delete
- `/admin`: every entry from every agent in one table, with a "Export CSV" button (handy for pulling data into Follow Up Boss)
- Data is stored in a real Postgres database, so it persists and multiple agents can use it at the same time

## Tech stack

Plain Node.js + Express + EJS templates + PostgreSQL (via the `pg` package). No build step, no framework lock-in — easy for any future developer to open and understand.

## Step 1 — Create a free Postgres database (Supabase)

1. Go to https://supabase.com and sign up (free).
2. Click **New Project**. Pick any name/region, set a database password (save it somewhere).
3. Once the project is created, go to **Project Settings → Database → Connection string**.
4. Copy the **URI** connection string (it looks like `postgresql://postgres:[YOUR-PASSWORD]@...supabase.co:5432/postgres`). Replace `[YOUR-PASSWORD]` with the password you set.
5. Add `?sslmode=require` to the end if it isn't already there.

Keep this connection string — you'll need it twice below.

## Step 2 — Deploy the app (Render)

1. Create a free account at https://render.com.
2. Push this project folder to a GitHub repo (or use Render's "Upload" option / connect the repo if you already have one in GitHub Desktop).
3. In Render, click **New → Web Service**, connect the repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment**, add an environment variable:
   - `DATABASE_URL` = the Supabase connection string from Step 1
6. Click **Create Web Service**. Render will build and deploy it, and give you a live URL like `https://openhouse-feedback.onrender.com`.

(Any other Node host — Railway, Fly.io, a VPS — works the same way: set `DATABASE_URL` and run `npm start`.)

## Step 3 — Create the tables and seed the agent list

The database starts empty. Run this **once** after your first deploy, from your own computer (with Node installed):

```bash
cd openhouse-feedback
npm install
DATABASE_URL="paste-your-supabase-connection-string-here" npm run seed
```

This creates the `agents` and `entries` tables and adds the 10 agents (Meredith, Chris, Rose, Stacy, Sandy, Dale, Patrick, Jason, Felicia, Francisco). Re-running it later is safe — it won't duplicate agents, and won't touch existing entries.

## Step 4 — Share the link

Send agents the live URL (e.g. `https://openhouse-feedback.onrender.com`). Each person clicks their name and gets their own page — nothing to install, no password.

## Adding, removing, or renaming an agent later

Open `db/init.js`, edit the `AGENTS` list at the top, then re-run:

```bash
DATABASE_URL="your-connection-string" npm run seed
```

## Running it locally to test changes

```bash
npm install
cp .env.example .env   # then paste your DATABASE_URL into .env
npm run seed
npm start
```

Visit http://localhost:3000

## Notes

- Free tiers: Supabase's free Postgres project and Render's free web service are both fine for a small team like this. Render's free tier "sleeps" after 15 minutes of no traffic and takes ~30 seconds to wake back up on the next visit — upgrading to Render's cheapest paid tier ($7/mo) removes that delay if it becomes annoying.
- All data lives in Supabase, independent of Render, so it's safe even if you redeploy or switch hosts later.
