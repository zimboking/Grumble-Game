// The real backend: Supabase client, anonymous sign-in and live updates.
//
// Every read goes through one database function per screen (host_state or
// player_state), so the browser never receives another person's answer.
// Realtime gives instant updates, and a slow poll is the safety net for
// patchy wi-fi: if a phone misses a message it catches up within seconds.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Content } from './content';
import { checkNickname, cleanRoomCode } from './nickname';
import type {
  HostBackend,
  HostSnapshot,
  JoinResult,
  PlayerBackend,
  PlayerSnapshot,
  RoomState,
  Round,
  Step,
} from './types';

const ROOM_KEY = 'grumble.room';
const HOST_POLL_MS = 1500;
const PLAYER_POLL_MS = 4000;

let client: SupabaseClient | null = null;
let signedIn: Promise<void> | null = null;

function db(): SupabaseClient {
  client ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

/** Gives this device a stable anonymous identity. No login screen. */
function ensureSignedIn(): Promise<void> {
  signedIn ??= (async () => {
    const { data } = await db().auth.getSession();
    if (data.session) return;
    const { error } = await db().auth.signInAnonymously();
    if (error) throw new Error(`Could not connect: ${error.message}`);
  })().catch((err) => {
    signedIn = null; // let the next call try again
    throw err;
  });
  return signedIn;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  await ensureSignedIn();
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

interface RoomJson {
  code: string;
  round: Round;
  idx: number;
  revealed: boolean;
  question_started_at: string | null;
  server_now: string;
}

/** Converts the server's start time to this device's clock, for the countdown. */
function toRoom(r: RoomJson | null): RoomState | null {
  if (!r) return null;
  const skew = Date.now() - Date.parse(r.server_now);
  return {
    code: r.code,
    round: r.round,
    idx: r.idx,
    revealed: r.revealed,
    questionStartedAt: r.question_started_at ? Date.parse(r.question_started_at) + skew : null,
  };
}

/**
 * Runs `refresh` now, on every realtime change, on a timer, and when the tab
 * wakes up or the network returns. Overlapping calls are folded into one.
 * `roomCode` says which room to listen to; the channel follows it, so joining
 * a room (or the room ending) rewires the subscription.
 */
function live(refresh: () => Promise<void>, pollMs: number, roomCode: () => string): () => void {
  let stopped = false;
  let running = false;
  let again = false;
  let channel: RealtimeChannel | null = null;
  let channelCode = '';

  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch (err) {
      console.warn('Refresh failed, will retry', err);
    }
    running = false;
    wire();
    if (again) {
      again = false;
      void run();
    }
  };

  const wire = () => {
    const code = roomCode();
    if (code === channelCode || stopped) return;
    if (channel) void db().removeChannel(channel);
    channelCode = code;
    channel = null;
    if (!code) return;
    const onChange = () => void run();
    channel = db()
      .channel(`room-${code}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, onChange)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${code}` },
        onChange,
      )
      .subscribe((status) => {
        // Covers anything missed while the connection was down.
        if (status === 'SUBSCRIBED') onChange();
      });
  };

  const onWake = () => {
    if (document.visibilityState === 'visible') void run();
  };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  const timer = window.setInterval(run, pollMs);
  void run();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('online', onWake);
    if (channel) void db().removeChannel(channel);
  };
}

// ---- Host -----------------------------------------------------------------

interface HostJson {
  room: RoomJson | null;
  players?: HostSnapshot['players'];
  progress?: HostSnapshot['progress'];
  counts?: number[] | null;
  summary?: Array<{ idx: number; average: number; votes: number; counts: number[] }> | null;
}

export function createSupabaseHostBackend(content: Content): HostBackend {
  let code = '';
  let poke: () => void = () => {};

  async function fetchSnapshot(): Promise<HostSnapshot> {
    const s = await rpc<HostJson>('host_state');
    const room = toRoom(s.room);
    code = room?.code ?? '';
    return {
      room,
      players: s.players ?? [],
      progress: s.progress ?? { answered: 0, total: 0 },
      counts: s.counts ?? null,
      summary: s.summary ? s.summary.map((row) => ({ ...row, average: Number(row.average) })) : null,
    };
  }

  return {
    subscribe(cb) {
      const refresh = async () => cb(await fetchSnapshot());
      // Any action by the host refreshes straight away.
      poke = () => void refresh().catch(() => {});
      return live(refresh, HOST_POLL_MS, () => code);
    },
    async createRoom() {
      await rpc('create_room');
      poke();
    },
    async goTo(step: Step) {
      if (!code) return;
      await rpc('go_to', { p_room: code, p_round: step.round, p_idx: step.idx, p_revealed: step.revealed });
      poke();
    },
    async reveal() {
      if (!code) return;
      const s = await fetchSnapshot();
      const correct = s.room?.round === 'quiz' ? content.quiz.questions[s.room.idx]?.correct : null;
      await rpc('reveal', { p_room: code, p_correct: correct ?? null });
      poke();
    },
    async endSession() {
      if (!code) return;
      await ensureSignedIn();
      const { error } = await db().from('rooms').delete().eq('code', code);
      if (error) throw new Error(error.message);
      poke();
    },
  };
}

// ---- Player ---------------------------------------------------------------

interface PlayerJson {
  room: RoomJson | null;
  me: PlayerSnapshot['me'];
  my_answer?: number | null;
  my_points?: number | null;
  my_vote?: number | null;
}

function storedRoom(): string {
  try {
    return localStorage.getItem(ROOM_KEY) ?? '';
  } catch {
    return '';
  }
}

export function createSupabasePlayerBackend(roomFromUrl: string): PlayerBackend {
  // The code in the QR link wins. Otherwise fall back to the last room joined,
  // so a refresh drops the player straight back in.
  let code = cleanRoomCode(roomFromUrl) || storedRoom();
  let poke: () => void = () => {};

  async function fetchSnapshot(): Promise<PlayerSnapshot> {
    if (code.length !== 4) return { room: null, me: null, myAnswer: null, myPoints: null, myVote: null };
    const s = await rpc<PlayerJson>('player_state', { p_room: code });
    return {
      room: toRoom(s.room),
      me: s.me ?? null,
      myAnswer: s.my_answer ?? null,
      myPoints: s.my_points ?? null,
      myVote: s.my_vote ?? null,
    };
  }

  return {
    subscribe(cb) {
      const refresh = async () => cb(await fetchSnapshot());
      poke = () => void refresh().catch(() => {});
      return live(refresh, PLAYER_POLL_MS, () => (code.length === 4 ? code : ''));
    },

    async join(roomCode: string, nickname: string): Promise<JoinResult> {
      const name = checkNickname(nickname);
      if (!name.ok) return name;
      const wanted = cleanRoomCode(roomCode);
      if (wanted.length !== 4) return { ok: false, error: 'The room code is 4 letters.' };
      try {
        await rpc('join_room', { p_room: wanted, p_nickname: name.value });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('room not found')) {
          return { ok: false, error: "We can't find that room. Check the code on the screen." };
        }
        return { ok: false, error: 'Could not join. Check your connection and try again.' };
      }
      code = wanted;
      try {
        localStorage.setItem(ROOM_KEY, code);
      } catch {
        // Without storage a refresh just asks for the nickname again.
      }
      poke();
      return { ok: true };
    },

    async answerQuiz(option: number) {
      await rpc('answer_quiz', { p_room: code, p_option: option }).catch((e) => console.warn(e));
      poke();
    },

    async voteGrumble(value: number) {
      await rpc('vote_grumble', { p_room: code, p_value: value }).catch((e) => console.warn(e));
      poke();
    },
  };
}
