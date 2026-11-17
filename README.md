# Rejoice With Me

A small live game for a Bible study group. Players join on their phones with a
QR code or a 4-letter room code. The host runs it from a laptop on a TV.

1. **Warm-up quiz:** scored multiple-choice questions with a leaderboard.
2. **Grumble-o-meter:** scenarios rated anonymously on a 5-point scale, shown
   as a bar chart for the group to discuss.

No app, no accounts. Votes live in Supabase, never in this repository.

## One-time setup

You need a free Supabase account and this GitHub repository. Allow about 20
minutes. Menu names in Supabase move now and then, so if a name below does not
match, look for the closest one.

### 1. Create the Supabase project

1. Go to supabase.com, sign in, and create a **New project**.
2. Pick the region closest to you (for Sydney, choose **Southeast Asia
   (Sydney)** or the nearest Australian option).
3. Wait for it to finish setting up.

### 2. Turn on anonymous sign-ins

1. Open **Authentication**, then **Sign In / Providers**.
2. Turn on **Allow anonymous sign-ins** and save.

Each phone signs in silently this way. Nobody sees a login screen.

### 3. Raise the sign-in rate limit

1. Open **Authentication**, then **Rate Limits**.
2. Find the limit for **anonymous sign-ins** (the default is about 30 an hour
   for each IP address).
3. Raise it to **200** and save.

Everyone on the church wi-fi shares one IP address. With the default, a big
night plus a few retries could leave the last people unable to join.

### 4. Create the database tables

The quick way, with nothing to install:

1. Open `supabase/migrations/20261117000000_init.sql` in this repository and
   copy the whole file.
2. In Supabase, open **SQL Editor**, paste it in, and press **Run**.
3. You should see "Success. No rows returned".

Run it once only. If you prefer the Supabase CLI, use this instead:

```bash
npx supabase login
```

```bash
npx supabase link
```

```bash
npx supabase db push
```

### 5. Copy the two keys into GitHub

1. In Supabase, open **Project Settings**, then **API** (or **API Keys**).
2. Copy the **Project URL** and the **anon / public** key. It may be labelled
   "publishable". Do not copy the "service role" or "secret" key. That one must
   never go anywhere near this repository.
3. In GitHub, open this repository, then **Settings**, **Secrets and
   variables**, **Actions**, **New repository secret**. Add two secrets:
   - `VITE_SUPABASE_URL` with the project URL
   - `VITE_SUPABASE_ANON_KEY` with the anon key

The anon key is designed to be public. The database rules do the protecting.

### 6. Turn on GitHub Pages

1. In GitHub, open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

Every push to `main` now builds and publishes the site. You can also open the
**Actions** tab, choose **Deploy to GitHub Pages**, and press **Run workflow**.

Your site will be at `https://<your-username>.github.io/<repository-name>/`.

### 7. Tell Supabase where the site lives

1. In Supabase, open **Authentication**, then **URL Configuration**.
2. Set **Site URL** to your GitHub Pages address from step 6.

## Running a session

1. On the laptop, open `https://<your-site>/#/host` and put it on the TV.
2. Press **Start session**. A QR code and a 4-letter code appear.
3. People scan the code, type a nickname and they are in.
4. Use the big button at the bottom to move through the game: **Start quiz**,
   **Reveal**, **Next**, and so on. The right arrow key does the same, and the
   left arrow goes back.
5. **Show QR again** is for late joiners. They land on the current screen.
6. At the end, press **End session**. This deletes the room and every answer.

### The day before

- Open the host page and start a session, join from your own phone, and click
  through to the end. If the Supabase project has been idle it may be paused.
  Open the Supabase dashboard and restore it if so.
- If the host page says "Demo mode", the two GitHub secrets are missing or the
  site has not been rebuilt since you added them. Run the deploy workflow again.

## Change the questions

Edit `public/content.json` and push. No code changes are needed.

- The quiz needs exactly four options per question. `correct` counts from 0,
  so `1` means the second option.
- The Grumble-o-meter needs exactly five scale labels.
- Set `secondsPerQuestion` to `0` to turn the countdown off. The countdown is
  only a nudge. Answers stay open until you press Reveal.
- Each scenario can be plain text, or text with a short label. The summary
  screen shows the short label, because the full text is too long to fit.

```json
{ "text": "Someone who left church for 20 years comes back...", "short": "The returning churchgoer" }
```

## How anonymity works

- The two tables that hold quiz answers and Grumble-o-meter votes cannot be
  read by anyone through the app or the API. Not players, not the host.
- The host screen only ever receives totals, and only after Reveal. Before
  that it gets a count such as "7 of 9 voted".
- Each phone can read back its own answer and nobody else's.
- Answers are never sent over the live channel.
- End session deletes everything. Any room older than 24 hours is also removed
  the next time anyone starts a session.

One honest limit: whoever owns the Supabase project can open the database in
the Supabase dashboard and see raw rows until the session is ended. So press
End session when you finish, and do not go looking.

## For developers

```bash
npm install
```

```bash
npm run dev
```

Without a `.env` file the app runs in demo mode: pretend players, nothing
saved. Open `http://localhost:5173/#/host` and a second tab for a phone.

To run against a local Supabase stack (needs Docker):

```bash
npx supabase start
```

```bash
npx supabase status -o env
```

Put `API_URL` and `ANON_KEY` from that output into `.env.local` as
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

Tests:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/policies.sql
```

```bash
npm run test:load
```

```bash
npm run build && npm run preview
```

```bash
npm run test:e2e
```

- `supabase/tests/policies.sql` signs in as a host, two players and an
  outsider, and proves what each can and cannot do (62 checks). It rolls
  itself back and leaves no data.
- `scripts/load-test.mjs` plays a full game with 15 simulated players and
  checks no answer is lost.
- `tests/e2e.mjs` plays a full game in real browsers: one host, three phones.

### Layout

```
index.html
src/
  main.ts           router: #/host, #/play, /?room=ABCD
  host.ts           TV and laptop view
  play.ts           phone view
  content.ts        loads and validates content.json
  flow.ts           screen order and quiz scoring rule
  supabase.ts       real backend: sign-in, database functions, live updates
  fake-backend.ts   demo mode backend with pretend players
  types.ts          the contract both backends follow
  ui/               small helpers: elements, bar chart, QR code
public/content.json
supabase/
  migrations/       tables, security rules, functions, realtime
  tests/            security tests
scripts/load-test.mjs
tests/e2e.mjs
.github/workflows/deploy.yml
```

To add a new question type later, add a round name in `types.ts`, its place in
the order in `flow.ts`, and a screen function in `host.ts` and `play.ts`.
