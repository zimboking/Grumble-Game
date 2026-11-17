// Step 1 stand-in for Supabase. State lives in localStorage so a host tab and
// phone tabs in the same browser stay in sync. A handful of pretend players
// answer on their own so the charts have something to show.
//
// It follows the same rules the database will enforce later: counts are
// withheld until Reveal, a quiz answer locks on first tap, a grumble vote can
// change until Reveal, and no snapshot says who voted what.

import type { Content } from './content';
import { quizPoints } from './flow';
import { checkNickname, cleanRoomCode, randomRoomCode } from './nickname';
import type {
  HostBackend,
  HostSnapshot,
  JoinResult,
  PlayerBackend,
  PlayerRow,
  PlayerSnapshot,
  RoomState,
  ScenarioSummary,
  Step,
} from './types';

const STORE_KEY = 'grumble.fake.store.v1';
const PLAYER_KEY = 'grumble.fake.player';
const BOT_NAMES = ['Marg', 'Davo', 'Helen', 'Rob', 'Sue', 'Pete', 'Jan', 'Col'];

interface QuizAnswer {
  option: number;
  at: number;
  points: number | null;
}

interface Store {
  room: RoomState | null;
  players: PlayerRow[];
  quiz: Record<string, Record<string, QuizAnswer>>;
  grumble: Record<string, Record<string, number>>;
  scored: number[];
}

const EMPTY: Store = { room: null, players: [], quiz: {}, grumble: {}, scored: [] };

function read(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Store) };
  } catch {
    // Unreadable storage just means an empty demo.
  }
  return { ...EMPTY };
}

const listeners = new Set<() => void>();

function write(store: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Private mode can refuse writes. The demo then only works in one tab.
  }
  listeners.forEach((fn) => fn());
}

function watch(fn: () => void, pollMs: number): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORE_KEY || e.key === null) fn();
  };
  window.addEventListener('storage', onStorage);
  const timer = window.setInterval(fn, pollMs);
  fn();
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
    window.clearInterval(timer);
  };
}

// ---- Pretend players ------------------------------------------------------

const botId = (i: number) => `bot-${i}`;
const isBot = (id: string) => id.startsWith('bot-');
const botIndex = (id: string) => Number(id.slice(4));

function botDelayMs(i: number, idx: number): number {
  return 1200 + ((i * 37 + idx * 53) % 7) * 900;
}

function botQuizOption(i: number, idx: number, content: Content): number {
  const correct = content.quiz.questions[idx]?.correct ?? 0;
  return (i + idx) % 4 === 0 ? (correct + 1 + i) % 4 : correct;
}

function botGrumbleValue(i: number, idx: number): number {
  const lean = [3, 2, 4, 2, 5][idx % 5];
  const wobble = ((i * 7 + idx * 3) % 4) - 1;
  return Math.min(5, Math.max(1, lean + wobble));
}

/** Writes in the bots whose answer time has passed. Returns true on change. */
function settleBots(store: Store, content: Content, now: number): boolean {
  const room = store.room;
  if (!room || room.revealed || room.questionStartedAt === null) return false;
  if (room.round !== 'quiz' && room.round !== 'grumble') return false;
  let changed = false;
  for (const p of store.players) {
    if (!isBot(p.id)) continue;
    const i = botIndex(p.id);
    const due = room.questionStartedAt + botDelayMs(i, room.idx);
    if (now < due) continue;
    if (room.round === 'quiz') {
      const answers = (store.quiz[room.idx] ??= {});
      if (!answers[p.id]) {
        answers[p.id] = { option: botQuizOption(i, room.idx, content), at: due, points: null };
        changed = true;
      }
    } else {
      const votes = (store.grumble[room.idx] ??= {});
      if (votes[p.id] === undefined) {
        votes[p.id] = botGrumbleValue(i, room.idx);
        changed = true;
      }
    }
  }
  return changed;
}

// ---- Counting (what the database functions will do) -----------------------

function tally(values: number[], size: number, offset: number): number[] {
  const counts = new Array<number>(size).fill(0);
  for (const v of values) counts[v - offset] += 1;
  return counts;
}

function grumbleSummary(store: Store, content: Content): ScenarioSummary[] {
  return content.grumble.scenarios
    .map((_, idx) => {
      const values = Object.values(store.grumble[idx] ?? {});
      const votes = values.length;
      const average = votes ? values.reduce((a, b) => a + b, 0) / votes : 0;
      return { idx, votes, average, counts: tally(values, content.grumble.scale.length, 1) };
    })
    .sort((a, b) => b.average - a.average || a.idx - b.idx);
}

function hostSnapshot(store: Store, content: Content): HostSnapshot {
  const room = store.room;
  const snap: HostSnapshot = {
    room,
    players: store.players,
    progress: { answered: 0, total: store.players.length },
    counts: null,
    summary: null,
  };
  if (!room) return snap;
  if (room.round === 'quiz') {
    const answers = Object.values(store.quiz[room.idx] ?? {});
    snap.progress.answered = answers.length;
    if (room.revealed) snap.counts = tally(answers.map((a) => a.option), 4, 0);
  } else if (room.round === 'grumble') {
    const votes = Object.values(store.grumble[room.idx] ?? {});
    snap.progress.answered = votes.length;
    if (room.revealed) snap.counts = tally(votes, content.grumble.scale.length, 1);
  } else if (room.round === 'summary') {
    snap.summary = grumbleSummary(store, content);
  }
  return snap;
}

function scoreQuestion(store: Store, content: Content, idx: number): void {
  if (store.scored.includes(idx)) return;
  const question = content.quiz.questions[idx];
  const startedAt = store.room?.questionStartedAt;
  if (!question || startedAt === null || startedAt === undefined) return;
  for (const [playerId, answer] of Object.entries(store.quiz[idx] ?? {})) {
    answer.points = quizPoints(answer.option === question.correct, (answer.at - startedAt) / 1000);
    const player = store.players.find((p) => p.id === playerId);
    if (player) player.score += answer.points;
  }
  store.scored.push(idx);
}

// ---- Host -----------------------------------------------------------------

export function createFakeHostBackend(content: Content): HostBackend {
  return {
    subscribe(cb) {
      return watch(() => {
        const store = read();
        if (settleBots(store, content, Date.now())) {
          write(store);
          return; // write() calls back in with the settled state
        }
        cb(hostSnapshot(store, content));
      }, 500);
    },

    async createRoom() {
      write({
        ...EMPTY,
        room: { code: randomRoomCode(), round: 'lobby', idx: 0, revealed: false, questionStartedAt: null },
        players: BOT_NAMES.map((nickname, i) => ({ id: botId(i), nickname, score: 0 })),
        quiz: {},
        grumble: {},
        scored: [],
      });
    },

    async goTo(step: Step) {
      const store = read();
      if (!store.room) return;
      const opens = (step.round === 'quiz' || step.round === 'grumble') && !step.revealed;
      store.room = { ...store.room, ...step, questionStartedAt: opens ? Date.now() : null };
      write(store);
    },

    async reveal() {
      const store = read();
      if (!store.room || store.room.revealed) return;
      settleBots(store, content, Date.now());
      if (store.room.round === 'quiz') scoreQuestion(store, content, store.room.idx);
      store.room.revealed = true;
      write(store);
    },

    async endSession() {
      write({ ...EMPTY });
    },
  };
}

// ---- Player ---------------------------------------------------------------

function myId(): string {
  // Per tab, so two tabs in one browser can act as two phones.
  let id = sessionStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = `p-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}

function playerSnapshot(store: Store, id: string): PlayerSnapshot {
  const room = store.room;
  const me = store.players.find((p) => p.id === id) ?? null;
  const snap: PlayerSnapshot = { room, me, myAnswer: null, myPoints: null, myVote: null };
  if (!room || !me) return snap;
  if (room.round === 'quiz') {
    const answer = store.quiz[room.idx]?.[id];
    snap.myAnswer = answer ? answer.option : null;
    snap.myPoints = room.revealed ? (answer?.points ?? 0) : null;
  } else if (room.round === 'grumble') {
    snap.myVote = store.grumble[room.idx]?.[id] ?? null;
  }
  return snap;
}

export function createFakePlayerBackend(): PlayerBackend {
  const id = myId();
  return {
    subscribe(cb) {
      return watch(() => cb(playerSnapshot(read(), id)), 1000);
    },

    async join(code: string, nickname: string): Promise<JoinResult> {
      const store = read();
      if (!store.room || store.room.code !== cleanRoomCode(code)) {
        return { ok: false, error: "We can't find that room. Check the code on the screen." };
      }
      const name = checkNickname(nickname);
      if (!name.ok) return name;
      const existing = store.players.find((p) => p.id === id);
      if (existing) existing.nickname = name.value;
      else store.players.push({ id, nickname: name.value, score: 0 });
      write(store);
      return { ok: true };
    },

    async answerQuiz(option: number) {
      const store = read();
      const room = store.room;
      if (!room || room.round !== 'quiz' || room.revealed) return;
      const answers = (store.quiz[room.idx] ??= {});
      if (answers[id]) return; // first tap locks in
      answers[id] = { option, at: Date.now(), points: null };
      write(store);
    },

    async voteGrumble(value: number) {
      const store = read();
      const room = store.room;
      if (!room || room.round !== 'grumble' || room.revealed) return;
      (store.grumble[room.idx] ??= {})[id] = value;
      write(store);
    },
  };
}
