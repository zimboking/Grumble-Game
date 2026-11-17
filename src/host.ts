// The TV and laptop view. One idea per screen, readable from across a room.

import type { Content } from './content';
import { ROUND_LABELS, needsReveal, nextStep, prevStep, primaryLabel } from './flow';
import type { HostBackend, HostSnapshot, PlayerRow, Round, Step } from './types';
import { scaleChart } from './ui/chart';
import { h, plural } from './ui/dom';
import { qrSvg } from './ui/qr';

const LETTERS = ['A', 'B', 'C', 'D'];

function joinUrl(code: string): string {
  return `${location.origin}${location.pathname}?room=${code}`;
}

function prettyUrl(): string {
  return `${location.host}${location.pathname}`.replace(/\/$/, '');
}

/** Places with ties sharing a rank: 1, 2, 2, 4. */
export function rankPlayers(players: PlayerRow[]): Array<PlayerRow & { place: number }> {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
  let place = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) place = i + 1;
    return { ...p, place };
  });
}

export function mountHost(root: HTMLElement, content: Content, backend: HostBackend): void {
  document.documentElement.classList.add('host-mode');
  document.title = `${content.title} · Host`;

  let snap: HostSnapshot | null = null;
  let lastKey = '';

  // ---- Fixed frame: top bar, main screen, control bar ----
  const joinHint = h('p', { class: 'join-hint' });
  const main = h('main', { class: 'host-main', id: 'screen', 'aria-live': 'polite' });

  const backBtn = h('button', { type: 'button', class: 'btn', onclick: () => act('back') }, 'Back');
  const primaryBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => act('primary') });
  const qrBtn = h('button', { type: 'button', class: 'btn', onclick: () => qrDialog.showModal() }, 'Show QR again');
  const endBtn = h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => act('end') }, 'End session');
  const skip = h(
    'select',
    { class: 'btn', 'aria-label': 'Skip to a round', onchange: () => act('skip') },
    h('option', { value: '' }, 'Skip to...'),
    (Object.keys(ROUND_LABELS) as Round[]).map((r) => h('option', { value: r }, ROUND_LABELS[r])),
  );
  const controls = h(
    'nav',
    { class: 'host-controls', 'aria-label': 'Host controls' },
    backBtn,
    primaryBtn,
    h('span', { class: 'spacer' }),
    skip,
    qrBtn,
    endBtn,
  );

  const qrDialog = h('dialog', { class: 'qr-dialog', 'aria-label': 'Join code' });

  root.replaceChildren(
    h(
      'header',
      { class: 'host-top' },
      h('p', { class: 'brand' }, h('strong', null, content.title), ' ', h('span', null, content.passage)),
      joinHint,
    ),
    main,
    controls,
    qrDialog,
  );

  // ---- Actions ----
  async function act(kind: 'primary' | 'back' | 'skip' | 'end'): Promise<void> {
    const room = snap?.room;
    if (!room) return;
    if (kind === 'primary') {
      if (needsReveal(room)) return backend.reveal();
      const next = nextStep(room, content);
      return next ? backend.goTo(next) : act('end');
    }
    if (kind === 'back') {
      const prev = prevStep(room, content);
      if (prev) await backend.goTo(prev);
      return;
    }
    if (kind === 'skip') {
      const round = skip.value as Round | '';
      skip.value = '';
      if (round) await backend.goTo({ round, idx: 0, revealed: false });
      return;
    }
    if (window.confirm('End the session? This removes the room and every answer.')) {
      await backend.endSession();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (qrDialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight') act('primary');
    else if (e.key === 'ArrowLeft') act('back');
  });

  // ---- Screens ----
  function joinPanel(code: string): HTMLElement {
    return h(
      'div',
      { class: 'join-panel' },
      qrSvg(joinUrl(code), `QR code to join room ${code}`),
      h(
        'div',
        { class: 'join-text' },
        h('p', null, 'Scan the code, or go to'),
        h('p', { class: 'join-url' }, prettyUrl()),
        h('p', null, 'and type'),
        h('p', { class: 'room-code', 'aria-label': `Room code ${code.split('').join(' ')}` }, code),
      ),
    );
  }

  function startScreen(): HTMLElement {
    return h(
      'section',
      { class: 'screen screen-center' },
      h('h1', { class: 'display' }, content.title),
      h('p', { class: 'lede' }, content.passage),
      h(
        'button',
        { type: 'button', class: 'btn btn-primary btn-big', onclick: () => backend.createRoom() },
        'Start session',
      ),
    );
  }

  function lobbyScreen(s: HostSnapshot, code: string): HTMLElement {
    return h(
      'section',
      { class: 'screen lobby' },
      joinPanel(code),
      h(
        'div',
        { class: 'lobby-players' },
        h('h2', null, plural(s.players.length, 'player', 'players'), ' in the room'),
        s.players.length
          ? h('ul', { class: 'chips' }, s.players.map((p) => h('li', null, p.nickname)))
          : h('p', { class: 'muted' }, 'Waiting for the first phone...'),
      ),
    );
  }

  function progressLine(noun: string): HTMLElement {
    return h('p', { class: 'progress', 'data-progress': noun });
  }

  function quizScreen(s: HostSnapshot, step: Step): HTMLElement {
    const q = content.quiz.questions[step.idx];
    if (!q) return missingScreen();
    const counts = s.counts;
    const max = Math.max(1, ...(counts ?? [0]));
    return h(
      'section',
      { class: 'screen quiz' },
      h('p', { class: 'kicker' }, `Question ${step.idx + 1} of ${content.quiz.questions.length}`),
      h('h1', { class: 'question' }, q.prompt),
      h(
        'ol',
        { class: 'options' },
        q.options.map((text, i) => {
          const isCorrect = step.revealed && i === q.correct;
          const count = counts ? counts[i] : null;
          return h(
            'li',
            { class: `option${isCorrect ? ' is-correct' : ''}${step.revealed && !isCorrect ? ' is-dim' : ''}` },
            count !== null && h('span', { class: 'option-fill', style: `width:${(count / max) * 100}%` }),
            h('span', { class: 'option-letter', 'aria-hidden': 'true' }, LETTERS[i]),
            h('span', { class: 'option-text' }, text, isCorrect && h('span', { class: 'tag' }, 'Correct')),
            count !== null && h('span', { class: 'option-count', 'aria-label': plural(count, 'answer', 'answers') }, count),
          );
        }),
      ),
      h(
        'div',
        { class: 'status-row' },
        progressLine('answered'),
        !step.revealed && content.quiz.secondsPerQuestion > 0 && h('p', { class: 'countdown', 'data-countdown': '' }),
      ),
    );
  }

  function leaderboardScreen(s: HostSnapshot): HTMLElement {
    const top = rankPlayers(s.players).slice(0, 5);
    return h(
      'section',
      { class: 'screen leaderboard' },
      h('p', { class: 'kicker' }, 'Quiz results'),
      h('h1', { class: 'question' }, 'Leaderboard'),
      h(
        'ol',
        { class: 'board' },
        top.map((p) =>
          h(
            'li',
            { class: p.place === 1 ? 'is-first' : '' },
            h('span', { class: 'board-place' }, p.place),
            h('span', { class: 'board-name' }, p.nickname),
            h('span', { class: 'board-score' }, p.score.toLocaleString('en-AU')),
          ),
        ),
      ),
    );
  }

  function grumbleScreen(s: HostSnapshot, step: Step): HTMLElement {
    const scenario = content.grumble.scenarios[step.idx];
    if (!scenario) return missingScreen();
    return h(
      'section',
      { class: `screen grumble${step.revealed ? ' is-revealed' : ''}` },
      h('p', { class: 'kicker' }, `Grumble-o-meter · ${step.idx + 1} of ${content.grumble.scenarios.length}`),
      h('h1', { class: 'question scenario' }, scenario.text),
      s.counts
        ? scaleChart(content.grumble.scale, s.counts)
        : h('div', { class: 'waiting' }, progressLine('voted'), h('p', { class: 'muted' }, content.grumble.intro)),
    );
  }

  function summaryScreen(s: HostSnapshot): HTMLElement {
    const top = content.grumble.scale.length;
    return h(
      'section',
      { class: 'screen summary' },
      h('p', { class: 'kicker' }, 'Grumble-o-meter'),
      h('h1', { class: 'question' }, 'Where we grumbled most'),
      h(
        'ol',
        { class: 'summary-list' },
        (s.summary ?? []).map((row, i) =>
          h(
            'li',
            null,
            h('span', { class: 'summary-rank' }, i + 1),
            h(
              'span',
              { class: 'summary-text', title: content.grumble.scenarios[row.idx].text },
              content.grumble.scenarios[row.idx].short ?? content.grumble.scenarios[row.idx].text,
            ),
            h(
              'span',
              { class: 'chart-track', 'aria-hidden': 'true' },
              h('span', {
                class: `chart-bar scale-${Math.min(top, Math.max(1, Math.round(row.average)))}`,
                style: `width:${(row.average / top) * 100}%`,
              }),
            ),
            h(
              'span',
              { class: 'summary-avg', 'aria-label': `Average ${row.average.toFixed(1)} out of ${top}` },
              row.votes ? row.average.toFixed(1) : 'No votes',
            ),
          ),
        ),
      ),
      h('p', { class: 'muted scale-key' }, `1 = ${content.grumble.scale[0]}, ${top} = ${content.grumble.scale[top - 1]}`),
    );
  }

  function missingScreen(): HTMLElement {
    return h('section', { class: 'screen screen-center' }, h('p', { class: 'lede' }, 'Nothing to show here.'));
  }

  function screenFor(s: HostSnapshot): HTMLElement {
    const room = s.room;
    if (!room) return startScreen();
    switch (room.round) {
      case 'lobby':
        return lobbyScreen(s, room.code);
      case 'quiz':
        return quizScreen(s, room);
      case 'leaderboard':
        return leaderboardScreen(s);
      case 'grumble':
        return grumbleScreen(s, room);
      case 'summary':
        return summaryScreen(s);
    }
  }

  // ---- Updating ----
  // The screen is rebuilt only when something structural changes. The ticking
  // parts (countdown, "7 of 9") are patched in place so keyboard focus on the
  // controls is never lost.
  function update(s: HostSnapshot): void {
    snap = s;
    const room = s.room;
    const showsPlayers = room?.round === 'lobby' || room?.round === 'leaderboard';
    const key = JSON.stringify([
      room && [room.code, room.round, room.idx, room.revealed],
      showsPlayers ? s.players : null,
      s.counts,
      s.summary,
    ]);
    if (key !== lastKey) {
      const codeChanged = !lastKey || JSON.parse(lastKey)[0]?.[0] !== room?.code;
      lastKey = key;
      main.replaceChildren(screenFor(s));
      if (codeChanged) qrDialog.replaceChildren(...(room ? dialogBody(room.code) : []));
    }

    const progress = main.querySelector<HTMLElement>('[data-progress]');
    if (progress) {
      progress.textContent = `${s.progress.answered} of ${s.progress.total} ${progress.dataset.progress}`;
    }
    const countdown = main.querySelector<HTMLElement>('[data-countdown]');
    if (countdown && room?.questionStartedAt) {
      const left = content.quiz.secondsPerQuestion - Math.floor((Date.now() - room.questionStartedAt) / 1000);
      countdown.textContent = left > 0 ? `${left}s` : "Time's up";
      countdown.classList.toggle('is-up', left <= 0);
    }

    controls.hidden = !room;
    joinHint.hidden = !room || room.round === 'lobby';
    if (room) {
      joinHint.replaceChildren('Join with code ', h('strong', null, room.code));
      const label = primaryLabel(room, content);
      if (primaryBtn.textContent !== label) primaryBtn.textContent = label;
      backBtn.disabled = prevStep(room, content) === null;
      endBtn.hidden = nextStep(room, content) === null && !needsReveal(room);
    }
  }

  function dialogBody(code: string): Node[] {
    return [
      joinPanel(code),
      h('form', { method: 'dialog' }, h('button', { class: 'btn btn-primary', autofocus: true }, 'Close')),
    ];
  }

  backend.subscribe(update);
}
