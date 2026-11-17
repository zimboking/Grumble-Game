// Entry point and router. Hash routes keep deep links working on GitHub Pages:
//   #/host            the TV and laptop view
//   #/play?room=ABCD  the phone view
//   /?room=ABCD       also the phone view (this is what the QR code points to)

import { loadContent } from './content';
import { createFakeHostBackend, createFakePlayerBackend } from './fake-backend';
import { mountHost } from './host';
import { mountPlay } from './play';
import { h } from './ui/dom';

async function start(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const room =
    new URLSearchParams(query).get('room') ?? new URLSearchParams(location.search).get('room') ?? '';

  try {
    const content = await loadContent();
    // Step 1 uses pretend data. The Supabase backend replaces these two lines.
    if (path === 'host') mountHost(app, content, createFakeHostBackend(content));
    else mountPlay(app, content, createFakePlayerBackend(), room);
  } catch (err) {
    app.replaceChildren(
      h(
        'main',
        { class: 'phone' },
        h(
          'section',
          { class: 'phone-center' },
          h('h1', null, 'Something went wrong'),
          h('p', { class: 'muted', role: 'alert' }, err instanceof Error ? err.message : String(err)),
        ),
      ),
    );
  }
}

window.addEventListener('hashchange', () => location.reload());
void start();
