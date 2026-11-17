// Entry point and router. Hash routes keep deep links working on GitHub Pages:
//   #/host            the TV and laptop view
//   #/play?room=ABCD  the phone view
//   /?room=ABCD       also the phone view (this is what the QR code points to)

import { loadContent } from './content';
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
    // With Supabase keys in the build this is the real game. Without them it
    // runs in demo mode on pretend data, which is handy for trying out content.
    const live = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
    if (live) {
      const real = await import('./supabase');
      if (path === 'host') mountHost(app, content, real.createSupabaseHostBackend(content), false);
      else mountPlay(app, content, real.createSupabasePlayerBackend(room), room);
    } else {
      const fake = await import('./fake-backend');
      if (path === 'host') mountHost(app, content, fake.createFakeHostBackend(content), true);
      else mountPlay(app, content, fake.createFakePlayerBackend(), room);
    }
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
