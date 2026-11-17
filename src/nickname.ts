// Nickname rules shared by the join form and (later) the database check.

export const NICKNAME_MAX = 16;

// A light filter only. It catches the obvious, not the determined.
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'bitch', 'wank', 'dick', 'cock', 'pussy', 'slut',
  'whore', 'arse', 'bastard', 'nigg', 'fag', 'retard', 'piss', 'twat',
];

export type NicknameCheck = { ok: true; value: string } | { ok: false; error: string };

export function checkNickname(input: string): NicknameCheck {
  const value = input.replace(/\s+/g, ' ').trim();
  if (value === '') return { ok: false, error: 'Please type a nickname.' };
  if (value.length > NICKNAME_MAX) {
    return { ok: false, error: `Keep it to ${NICKNAME_MAX} characters or fewer.` };
  }
  const squashed = value.toLowerCase().replace(/[^a-z]/g, '');
  if (BLOCKED.some((word) => squashed.includes(word))) {
    return { ok: false, error: 'Please pick a different nickname.' };
  }
  return { ok: true, value };
}

// No I, L or O, so a code read off a TV is never ambiguous.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomRoomCode(): string {
  const picks = new Uint32Array(4);
  crypto.getRandomValues(picks);
  return Array.from(picks, (n) => CODE_LETTERS[n % CODE_LETTERS.length]).join('');
}

export function cleanRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}
