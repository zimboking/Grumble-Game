// The phone view. Big buttons, one thing to do at a time, nothing to scroll.

import type { Content } from './content';
import { NICKNAME_MAX, cleanRoomCode } from './nickname';
import type { PlayerBackend, PlayerSnapshot, RoomState } from './types';
import { h } from './ui/dom';

const LETTERS = ['A', 'B', 'C', 'D'];

export function mountPlay(
  root: HTMLElement,
  content: Content,
  backend: PlayerBackend,
  roomFromUrl: string,
): void {
  document.documentElement.classList.add('play-mode');
  document.title = content.title;

  const main = h('main', { class: 'phone' });
  root.replaceChildren(main);

  let lastKey = '';
  let joinError = '';
  // Kept across re-renders so a failed join does not wipe what was typed.
  let draftCode = cleanRoomCode(roomFromUrl);
  let draftName = '';

  function header(sub?: string): HTMLElement {
    return h(
      'header',
      { class: 'phone-head' },
      h('p', { class: 'brand' }, content.title),
      sub && h('p', { class: 'phone-sub' }, sub),
    );
  }

  function message(title: string, body?: string, extra?: Node | false | null): HTMLElement[] {
    return [
      header(),
      h(
        'section',
        { class: 'phone-center', 'aria-live': 'polite' },
        h('h1', null, title),
        body && h('p', { class: 'muted' }, body),
        extra,
      ),
    ];
  }

  // ---- Join ----
  function joinScreen(): HTMLElement[] {
    const code = h('input', {
      id: 'code',
      name: 'code',
      class: 'input input-code',
      value: draftCode,
      maxlength: 4,
      autocomplete: 'off',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: 'false',
      inputmode: 'text',
      required: true,
      oninput: () => {
        code.value = cleanRoomCode(code.value);
        draftCode = code.value;
      },
    });
    const name = h('input', {
      id: 'nickname',
      name: 'nickname',
      class: 'input',
      value: draftName,
      maxlength: NICKNAME_MAX,
      autocomplete: 'off',
      required: true,
      'aria-describedby': 'nickname-help',
      oninput: () => {
        draftName = name.value;
      },
    });
    const form = h(
      'form',
      {
        class: 'join-form',
        novalidate: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const result = await backend.join(code.value, name.value);
          joinError = result.ok ? '' : result.error;
          if (!result.ok) render(true);
        },
      },
      h('label', { for: 'code' }, 'Room code'),
      code,
      h('label', { for: 'nickname' }, 'Your nickname'),
      name,
      h('p', { id: 'nickname-help', class: 'help' }, 'Only used for the quiz scores.'),
      joinError && h('p', { class: 'error', role: 'alert' }, joinError),
      h('button', { type: 'submit', class: 'tap tap-primary' }, 'Join'),
    );
    return [header(content.passage), form];
  }

  // ---- Quiz ----
  function quizScreen(s: PlayerSnapshot, room: RoomState): HTMLElement[] {
    const q = content.quiz.questions[room.idx];
    if (!q) return message('Look at the screen.');
    const locked = s.myAnswer !== null;

    if (room.revealed) {
      const right = s.myAnswer === q.correct;
      const title = !locked ? 'No answer this time' : right ? 'Correct' : 'Not this time';
      return message(
        title,
        `The answer was ${LETTERS[q.correct]}: ${q.options[q.correct]}`,
        h(
          'p',
          { class: 'points' },
          h('strong', null, `+${(s.myPoints ?? 0).toLocaleString('en-AU')}`),
          ` points. Total ${(s.me?.score ?? 0).toLocaleString('en-AU')}.`,
        ),
      );
    }

    return [
      header(`Question ${room.idx + 1} of ${content.quiz.questions.length}`),
      h('h1', { class: 'phone-prompt' }, q.prompt),
      h(
        'div',
        { class: 'taps', role: 'group', 'aria-label': 'Answers' },
        q.options.map((text, i) =>
          h(
            'button',
            {
              type: 'button',
              class: `tap${s.myAnswer === i ? ' is-picked' : ''}`,
              disabled: locked,
              'aria-pressed': String(s.myAnswer === i),
              onclick: () => backend.answerQuiz(i),
            },
            h('span', { class: 'tap-letter', 'aria-hidden': 'true' }, LETTERS[i]),
            h('span', { class: 'tap-text' }, text),
          ),
        ),
      ),
      h('p', { class: 'phone-foot', 'aria-live': 'polite' }, locked ? 'Locked in. Look at the screen.' : 'Tap your answer.'),
    ];
  }

  // ---- Grumble-o-meter ----
  function grumbleScreen(s: PlayerSnapshot, room: RoomState): HTMLElement[] {
    const scenario = content.grumble.scenarios[room.idx];
    if (!scenario) return message('Look at the screen.');
    const foot = room.revealed
      ? 'Voting has closed. Look at the screen.'
      : s.myVote !== null
        ? 'Saved. You can change it until the reveal.'
        : 'How would you honestly feel?';
    return [
      h('p', { class: 'anon-banner' }, 'Your answers here are anonymous.'),
      h('h1', { class: 'phone-scenario' }, scenario.text),
      h(
        'div',
        { class: 'taps', role: 'group', 'aria-label': 'Your answer' },
        content.grumble.scale.map((label, i) =>
          h(
            'button',
            {
              type: 'button',
              class: `tap tap-scale${s.myVote === i + 1 ? ' is-picked' : ''}`,
              disabled: room.revealed,
              'aria-pressed': String(s.myVote === i + 1),
              onclick: () => backend.voteGrumble(i + 1),
            },
            h('span', { class: `tap-swatch scale-${i + 1}`, 'aria-hidden': 'true' }),
            h('span', { class: 'tap-text' }, label),
          ),
        ),
      ),
      h('p', { class: 'phone-foot', 'aria-live': 'polite' }, foot),
    ];
  }

  function screenFor(s: PlayerSnapshot): HTMLElement[] {
    if (!s.me || !s.room) return joinScreen();
    switch (s.room.round) {
      case 'lobby':
        return message("You're in. Look at the screen.", `Playing as ${s.me.nickname}.`);
      case 'quiz':
        return quizScreen(s, s.room);
      case 'leaderboard':
        return message(
          `${s.me.score.toLocaleString('en-AU')} points`,
          'Nice work. Look at the screen for the leaderboard.',
        );
      case 'grumble':
        return grumbleScreen(s, s.room);
      case 'summary':
        return message('Thanks for playing.', 'Look at the screen.');
    }
  }

  let current: PlayerSnapshot | null = null;

  function render(force = false): void {
    if (!current) return;
    const s = current;
    const key = JSON.stringify([
      s.room && [s.room.code, s.room.round, s.room.idx, s.room.revealed],
      s.me,
      s.myAnswer,
      s.myPoints,
      s.myVote,
    ]);
    if (key === lastKey && !force) return;
    lastKey = key;
    main.replaceChildren(...screenFor(s));
  }

  backend.subscribe((s) => {
    current = s;
    render();
  });
}
