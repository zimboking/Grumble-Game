// Shared shapes. The snapshots mirror what the Supabase tables and RPCs will
// return in later steps, so the screens are built against the real contract:
// counts are null until Reveal, and nothing here carries who voted what.

export type Round = 'lobby' | 'quiz' | 'leaderboard' | 'grumble' | 'summary';

export interface Step {
  round: Round;
  idx: number;
  revealed: boolean;
}

export interface RoomState extends Step {
  code: string;
  /** Epoch ms when the current question or scenario opened. */
  questionStartedAt: number | null;
}

export interface PlayerRow {
  id: string;
  nickname: string;
  score: number;
}

export interface Progress {
  answered: number;
  total: number;
}

export interface ScenarioSummary {
  idx: number;
  average: number;
  votes: number;
  counts: number[];
}

export interface HostSnapshot {
  room: RoomState | null;
  players: PlayerRow[];
  progress: Progress;
  /** Per option or scale point. Null until the host reveals. */
  counts: number[] | null;
  /** Only on the summary screen. */
  summary: ScenarioSummary[] | null;
}

export interface PlayerSnapshot {
  room: RoomState | null;
  me: PlayerRow | null;
  /** This player's own answer for the current quiz question. */
  myAnswer: number | null;
  /** Points for the current question. Null until Reveal. */
  myPoints: number | null;
  /** This player's own vote (1 to 5) for the current scenario. */
  myVote: number | null;
}

export type JoinResult = { ok: true } | { ok: false; error: string };

export interface HostBackend {
  subscribe(cb: (snap: HostSnapshot) => void, onError?: (message: string | null) => void): () => void;
  createRoom(): Promise<void>;
  goTo(step: Step): Promise<void>;
  reveal(): Promise<void>;
  endSession(): Promise<void>;
}

export interface PlayerBackend {
  subscribe(cb: (snap: PlayerSnapshot) => void, onError?: (message: string | null) => void): () => void;
  join(code: string, nickname: string): Promise<JoinResult>;
  answerQuiz(option: number): Promise<void>;
  voteGrumble(value: number): Promise<void>;
}
