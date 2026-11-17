// Load test: one host and N simulated players play a whole game through the
// same database functions the app uses, then check that no answer was lost.
//
//   node --env-file=.env.local scripts/load-test.mjs        (15 players)
//   node --env-file=.env.local scripts/load-test.mjs 25
//
// Each simulated player signs in anonymously, so mind the sign-in rate limit.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');

const PLAYERS = Number(process.argv[2] ?? 15);
const content = JSON.parse(readFileSync(new URL('../public/content.json', import.meta.url), 'utf8'));

async function user() {
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return c;
}
async function call(c, fn, args) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
let checks = 0;
function expect(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

const t0 = Date.now();
const host = await user();
const room = await call(host, 'create_room');
const players = await Promise.all(Array.from({ length: PLAYERS }, user));
await Promise.all(players.map((p, i) => call(p, 'join_room', { p_room: room, p_nickname: `Player ${i + 1}` })));
let state = await call(host, 'host_state');
expect(state.players.length === PLAYERS, 'everyone is in the lobby');

for (let q = 0; q < content.quiz.questions.length; q++) {
  const correct = content.quiz.questions[q].correct;
  await call(host, 'go_to', { p_room: room, p_round: 'quiz', p_idx: q, p_revealed: false });
  const picks = players.map((_, i) => (i % 3 === 0 ? (correct + 1) % 4 : correct));
  await Promise.all(players.map((p, i) => call(p, 'answer_quiz', { p_room: room, p_option: picks[i] })));
  state = await call(host, 'host_state');
  expect(state.progress.answered === PLAYERS, `question ${q + 1}: all ${PLAYERS} answers recorded`);
  expect(state.counts === null, `question ${q + 1}: counts hidden before reveal`);
  await call(host, 'reveal', { p_room: room, p_correct: correct });
  state = await call(host, 'host_state');
  expect(sum(state.counts) === PLAYERS, `question ${q + 1}: counts add up`);
  expect(state.counts[correct] === picks.filter((x) => x === correct).length, `question ${q + 1}: correct count matches`);
}
const right = players.filter((_, i) => i % 3 !== 0).length;
expect(state.players.filter((p) => p.score >= 500 * content.quiz.questions.length).length === right, 'scores match correct answers');
expect(state.players.filter((p) => p.score === 0).length === PLAYERS - right, 'wrong answers scored 0');

const expected = [];
for (let s = 0; s < content.grumble.scenarios.length; s++) {
  await call(host, 'go_to', { p_room: room, p_round: 'grumble', p_idx: s, p_revealed: false });
  // Everyone votes, then everyone changes their mind once.
  await Promise.all(players.map((p, i) => call(p, 'vote_grumble', { p_room: room, p_value: 1 + (i % 5) })));
  const finalVotes = players.map((_, i) => 1 + ((i + s) % 5));
  await Promise.all(players.map((p, i) => call(p, 'vote_grumble', { p_room: room, p_value: finalVotes[i] })));
  state = await call(host, 'host_state');
  expect(state.progress.answered === PLAYERS && state.counts === null, `scenario ${s + 1}: ${PLAYERS} votes, hidden before reveal`);
  await call(host, 'reveal', { p_room: room });
  state = await call(host, 'host_state');
  const want = [1, 2, 3, 4, 5].map((v) => finalVotes.filter((x) => x === v).length);
  expect(JSON.stringify(state.counts) === JSON.stringify(want), `scenario ${s + 1}: totals match final votes`);
  expected.push(sum(finalVotes) / PLAYERS);
}

await call(host, 'go_to', { p_room: room, p_round: 'summary', p_idx: 0, p_revealed: false });
state = await call(host, 'host_state');
expect(state.summary.length === content.grumble.scenarios.length, 'summary has every scenario');
for (const row of state.summary) {
  expect(Math.abs(Number(row.average) - expected[row.idx]) < 0.01 && row.votes === PLAYERS, `summary average for scenario ${row.idx + 1}`);
}

// A player asking the API directly for raw rows gets nothing.
for (const table of ['grumble_votes', 'quiz_answers']) {
  const { data, error } = await players[0].from(table).select('*');
  expect(Boolean(error) || (data ?? []).length === 0, `player cannot read ${table}`);
  const asHost = await host.from(table).select('*');
  expect(Boolean(asHost.error) || (asHost.data ?? []).length === 0, `host cannot read ${table}`);
}

const { error: delError } = await host.from('rooms').delete().eq('code', room);
expect(!delError, 'end session');
state = await call(host, 'host_state');
expect(state.room === null, 'room is gone after end session');
const after = await call(players[0], 'player_state', { p_room: room });
expect(after.room === null, 'players see the room has ended');

console.log(`PASSED: ${checks} checks, ${PLAYERS} players, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
