import { h, plural } from './dom';

/**
 * Horizontal bars for the five scale points. One sequential colour ramp from
 * the first label to the last. No "good" or "bad" colours: there is no right
 * answer in the Grumble-o-meter.
 */
export function scaleChart(labels: string[], counts: number[]): HTMLElement {
  const max = Math.max(1, ...counts);
  return h(
    'ol',
    { class: 'chart', 'aria-label': 'Votes for each answer' },
    labels.map((label, i) => {
      const count = counts[i] ?? 0;
      return h(
        'li',
        { class: 'chart-row', 'aria-label': `${label}: ${plural(count, 'vote', 'votes')}` },
        h('span', { class: 'chart-label', 'aria-hidden': 'true' }, label),
        h(
          'span',
          { class: 'chart-track', 'aria-hidden': 'true' },
          count > 0 && h('span', { class: `chart-bar scale-${i + 1}`, style: `width:${(count / max) * 100}%` }),
        ),
        h('span', { class: 'chart-count', 'aria-hidden': 'true' }, count),
      );
    }),
  );
}
