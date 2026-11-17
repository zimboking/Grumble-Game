# Rejoice With Me

A small live game for a Bible study group. Players join on their phones with a
QR code or a 4-letter room code. The host runs it from a laptop on a TV.

1. **Warm-up quiz:** scored multiple-choice questions with a leaderboard.
2. **Grumble-o-meter:** scenarios rated anonymously on a 5-point scale, shown
   as a bar chart for the group to discuss.

## Status

Build step 1 of 8 is done: the screens work end to end with pretend data.
There is no Supabase connection yet, so nothing leaves the browser. The full
setup guide for Supabase and GitHub Pages will be added in step 8.

## Try it

```bash
npm install
```

```bash
npm run dev
```

Then open the host view at `http://localhost:5173/#/host`, press **Start
session**, and open the join link in a second tab of the same browser to act
as a phone. Eight pretend players answer on their own.

## Change the questions

Edit `public/content.json`. No code changes are needed. The quiz needs exactly
four options per question and the Grumble-o-meter needs exactly five scale
labels. Set `secondsPerQuestion` to `0` to turn the countdown off.

## Layout

```
index.html
src/
  main.ts           router: #/host, #/play, /?room=ABCD
  host.ts           TV and laptop view
  play.ts           phone view
  content.ts        loads and validates content.json
  flow.ts           screen order and quiz scoring rule
  fake-backend.ts   pretend data for step 1 (Supabase replaces this)
  types.ts          the contract both backends follow
  ui/               small helpers: elements, bar chart, QR code
public/content.json
```
