// End-to-end test: one host and three phones play the whole game in real
// browsers against a build that is connected to Supabase.
//
//   npm run build && npm run preview        (in one terminal)
//   node tests/e2e.mjs                      (in another)
//
// Set BASE_URL to test a deployed site instead of the local preview.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is not a project dependency. Install it once with:
//   npm install --no-save playwright && npx playwright install chromium
const { chromium } = createRequire(import.meta.url)('playwright');

const base = process.env.BASE_URL ?? 'http://localhost:4173/';
const content = JSON.parse(readFileSync(new URL('../public/content.json', import.meta.url), 'utf8'));
const names = ['Ann', 'Bob', 'Cat'];

let checks = 0;
function expect(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

const browser = await chromium.launch();
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const host = await hostCtx.newPage();
const phones = [];
for (const _ of names) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  phones.push(await ctx.newPage());
}
const errors = [];
for (const p of [host, ...phones]) p.on('pageerror', (e) => errors.push(String(e)));

const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 10000 });
const until = (page, sel, has) => page.locator(sel, { hasText: has }).first().waitFor({ timeout: 10000 });
const primary = () => host.locator('.host-controls .btn-primary').click();

try {
  await host.goto(`${base}#/host`);
  const started = Date.now();
  await host.getByRole('button', { name: 'Start session' }).click();
  await host.locator('.lobby .qr').waitFor({ timeout: 10000 });
  const qrMs = Date.now() - started;
  expect(qrMs < 3000, `QR code shows within 3 seconds (${qrMs}ms)`);
  const code = (await text(host, '.room-code')).trim();
  expect(/^[A-Z]{4}$/.test(code), `room code ${code}`);

  // Join: two by link, one by typing the code.
  for (const [i, phone] of phones.entries()) {
    await phone.goto(i === 2 ? base : `${base}?room=${code}`);
    if (i === 2) await phone.getByLabel('Room code').fill(code.toLowerCase());
    await phone.getByLabel('Your nickname').fill(names[i]);
    await phone.getByRole('button', { name: 'Join' }).click();
    await until(phone, 'h1', "You're in");
  }
  await until(host, '.lobby-players h2', '3 players');
  expect(true, 'three players in the lobby');

  // ---- Quiz ----
  for (let q = 0; q < content.quiz.questions.length; q++) {
    const correct = content.quiz.questions[q].correct;
    await primary();
    await until(host, '.kicker', `Question ${q + 1}`);
    for (const [i, phone] of phones.entries()) {
      await phone.locator('.tap').first().waitFor({ timeout: 10000 });
      // Bob is always wrong.
      await phone.locator('.tap').nth(i === 1 ? (correct + 1) % 4 : correct).click();
      await until(phone, '.phone-foot', 'Locked in');
    }
    await until(host, '[data-progress]', '3 of 3 answered');
    expect((await host.locator('.option-count').count()) === 0, `question ${q + 1}: counts hidden before reveal`);

    if (q === 0) {
      await phones[0].reload();
      await until(phones[0], '.phone-foot', 'Locked in');
      expect(true, 'a refreshed phone rejoins as the same player with its answer kept');
    }

    await primary();
    await host.locator('.option.is-correct').waitFor({ timeout: 10000 });
    const counts = await host.locator('.option-count').allTextContents();
    expect(Number(counts[correct]) === 2 && counts.map(Number).reduce((a, b) => a + b) === 3, `question ${q + 1}: counts after reveal`);
    await until(phones[0], 'h1', 'Correct');
    await until(phones[1], 'h1', 'Not this time');
  }

  await primary();
  await host.locator('.board li').first().waitFor({ timeout: 10000 });
  const board = await host.locator('.board-name').allTextContents();
  expect(board.length === 3 && board[2] === 'Bob', `leaderboard order: ${board.join(', ')}`);
  const scores = (await host.locator('.board-score').allTextContents()).map((s) => Number(s.replace(/,/g, '')));
  expect(scores[0] >= 1500 && scores[2] === 0, `scores: ${scores.join(', ')}`);

  // ---- Grumble-o-meter ----
  const votes = [5, 3, 5];
  for (let s = 0; s < content.grumble.scenarios.length; s++) {
    await primary();
    await until(host, '.kicker', `${s + 1} of ${content.grumble.scenarios.length}`);
    for (const [i, phone] of phones.entries()) {
      await until(phone, '.anon-banner', 'anonymous');
      await phone.locator('.tap').first().waitFor();
      if (i === 0) {
        // Ann changes her mind before the reveal.
        await phone.locator('.tap').nth(0).click();
        await until(phone, '.phone-foot', 'Saved');
      }
      await phone.locator('.tap').nth(votes[i] - 1).click();
      await phone.locator(`.tap.is-picked >> nth=0`).waitFor({ timeout: 10000 });
    }
    await until(host, '[data-progress]', '3 of 3 voted');
    expect((await host.locator('.chart').count()) === 0, `scenario ${s + 1}: chart hidden before reveal`);
    await primary();
    await host.locator('.chart').waitFor({ timeout: 10000 });
    const counts = (await host.locator('.chart-count').allTextContents()).map(Number);
    expect(counts.join() === '0,0,1,0,2', `scenario ${s + 1}: chart shows ${counts.join()}`);
    await until(phones[2], '.phone-foot', 'Voting has closed');
  }

  await primary();
  await host.locator('.summary-list li').first().waitFor({ timeout: 10000 });
  expect((await host.locator('.summary-list li').count()) === content.grumble.scenarios.length, 'summary lists every scenario');
  expect((await text(host, '.summary-avg')).trim() === '4.3', 'summary average is 4.3');

  // ---- A phone asks the API directly for raw votes ----
  const leak = await phones[0].evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'));
    return { token: JSON.parse(localStorage.getItem(key)).access_token };
  });
  const env = Object.fromEntries(
    readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  for (const table of ['grumble_votes', 'quiz_answers']) {
    const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${leak.token}` },
    });
    const body = await res.json();
    expect(!res.ok || body.length === 0, `direct API query for ${table} returns no rows (HTTP ${res.status})`);
  }

  // ---- End session ----
  host.once('dialog', (d) => d.accept());
  await primary();
  await host.getByRole('button', { name: 'Start session' }).waitFor({ timeout: 10000 });
  await phones[1].getByRole('button', { name: 'Join' }).waitFor({ timeout: 10000 });
  expect(true, 'end session returns host to the start and phones to the join screen');

  expect(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  console.log(`PASSED: ${checks} checks`);
} finally {
  await browser.close();
}
