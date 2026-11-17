// The order of screens, as pure functions so the host buttons and the tests
// agree on what Next and Back mean.

import type { Content } from './content';
import type { Round, Step } from './types';

export function nextStep(s: Step, c: Content): Step | null {
  const questions = c.quiz.questions.length;
  const scenarios = c.grumble.scenarios.length;
  const startGrumble: Step = scenarios > 0
    ? { round: 'grumble', idx: 0, revealed: false }
    : { round: 'summary', idx: 0, revealed: false };

  switch (s.round) {
    case 'lobby':
      return questions > 0 ? { round: 'quiz', idx: 0, revealed: false } : startGrumble;
    case 'quiz':
      return s.idx + 1 < questions
        ? { round: 'quiz', idx: s.idx + 1, revealed: false }
        : { round: 'leaderboard', idx: 0, revealed: false };
    case 'leaderboard':
      return startGrumble;
    case 'grumble':
      return s.idx + 1 < scenarios
        ? { round: 'grumble', idx: s.idx + 1, revealed: false }
        : { round: 'summary', idx: 0, revealed: false };
    case 'summary':
      return null;
  }
}

/** Going back always lands on an already revealed screen, so nothing reopens. */
export function prevStep(s: Step, c: Content): Step | null {
  const questions = c.quiz.questions.length;
  const scenarios = c.grumble.scenarios.length;
  const lobby: Step = { round: 'lobby', idx: 0, revealed: false };
  const lastQuiz: Step = questions > 0 ? { round: 'quiz', idx: questions - 1, revealed: true } : lobby;

  switch (s.round) {
    case 'lobby':
      return null;
    case 'quiz':
      return s.idx > 0 ? { round: 'quiz', idx: s.idx - 1, revealed: true } : lobby;
    case 'leaderboard':
      return lastQuiz;
    case 'grumble':
      if (s.idx > 0) return { round: 'grumble', idx: s.idx - 1, revealed: true };
      return questions > 0 ? { round: 'leaderboard', idx: 0, revealed: false } : lobby;
    case 'summary':
      return scenarios > 0 ? { round: 'grumble', idx: scenarios - 1, revealed: true } : lastQuiz;
  }
}

export function needsReveal(s: Step): boolean {
  return (s.round === 'quiz' || s.round === 'grumble') && !s.revealed;
}

/** Label for the one main host button. */
export function primaryLabel(s: Step, c: Content): string {
  if (needsReveal(s)) return 'Reveal';
  const next = nextStep(s, c);
  if (!next) return 'End session';
  if (s.round === 'lobby') return next.round === 'quiz' ? 'Start quiz' : 'Start Grumble-o-meter';
  if (s.round === 'leaderboard') return 'Start Grumble-o-meter';
  if (next.round === 'leaderboard') return 'Show leaderboard';
  if (next.round === 'summary') return 'Show summary';
  return 'Next';
}

export const ROUND_LABELS: Record<Round, string> = {
  lobby: 'Lobby',
  quiz: 'Quiz',
  leaderboard: 'Leaderboard',
  grumble: 'Grumble-o-meter',
  summary: 'Summary',
};

/** Points for a correct answer: 1000 minus 25 per second, never below 500. */
export function quizPoints(correct: boolean, secondsTaken: number): number {
  if (!correct) return 0;
  return Math.max(500, 1000 - 25 * Math.max(0, Math.floor(secondsTaken)));
}
