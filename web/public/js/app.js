import { api } from './lib/api.js';
import { $, clear, h, icon, mount } from './lib/dom.js';
import { badge, toast } from './lib/ui.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDevices } from './views/devices.js';
import { renderImport } from './views/import.js';
import { renderLibrary } from './views/library.js';
import { renderPlaylist, renderPlaylists } from './views/playlists.js';
import { renderSearch } from './views/search.js';
import { renderSettings } from './views/settings.js';
import { renderArtists } from './views/artists.js';
import { renderAlbums } from './views/albums.js';
import { renderAlbumPage, renderArtistPage } from './views/browse.js';

// Application shell: session bootstrap, hash routing, navigation.

// Shared, mutable app state. Small enough that a store would be ceremony.
export const state = {
  user: null,
  providers: { deezer: false, itunes: false, musicbrainz: false },
  stats: null,
};

// Hash routing rather than the History API. It needs no server-side rewrite
// rules beyond the catch-all already in place, and a copied URL works when
// pasted into a fresh tab.
const routes = [
  { path: '', title: 'Overview', render: renderDashboard, nav: 'Overview', icon: 'home' },
  { path: 'library', title: 'Library', render: renderLibrary, nav: 'Songs', icon: 'music' },
  { path: 'albums', title: 'Albums', render: renderAlbums, nav: 'Albums', icon: 'album' },
  { path: 'artists', title: 'Artists', render: renderArtists, nav: 'Artists', icon: 'user' },
  { path: 'playlists', title: 'Playlists', render: renderPlaylists, nav: 'Playlists', icon: 'list' },
  { path: 'playlists/:id', title: 'Playlist', render: renderPlaylist },
  { path: 'search', title: 'Add music', render: renderSearch, nav: 'Add music', icon: 'search', group: 'Add' },
  { path: 'import', title: 'Import', render: renderImport, nav: 'Import', icon: 'download', group: 'Add' },
  // Provider-backed browsing, reached from a search result rather than the
  // sidebar: these are pages about music that is not in the library yet.
  { path: 'artist/:id', title: 'Artist', render: renderArtistPage },
  { path: 'album/:id', title: 'Album', render: renderAlbumPage },
  { path: 'devices', title: 'Devices', render: renderDevices, nav: 'Devices', icon: 'device', group: 'Sync' },
  { path: 'settings', title: 'Settings', render: renderSettings, nav: 'Settings', icon: 'settings', group: 'Sync' },
];

function matchRoute(hash) {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');

  for (const route of routes) {
    if (route.path === path) return { route, params: {} };
  }
  // Parameterised routes, compared segment by segment.
  for (const route of routes) {
    if (!route.path.includes(':')) continue;
    const routeParts = route.path.split('/');
    const pathParts = path.split('/');
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    const matched = routeParts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[index]);
        return true;
      }
      return part === pathParts[index];
    });
    if (matched) return { route, params };
  }
  return null;
}

function buildNav(activePath) {
  const nav = $('#nav');
  clear(nav);

  // Grouped, with the ungrouped items first. Keeps "what is in my library"
  // separate from "how do I get more into it" and "how does it reach the iPod".
  const groups = new Map();
  for (const route of routes) {
    if (!route.nav) continue;
    const group = route.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(route);
  }

  for (const [group, items] of groups) {
    if (group) nav.appendChild(h('div.nav-group-label', group));
    for (const route of items) {
      const isActive =
        route.path === activePath ||
        // A playlist detail page should keep Playlists highlighted.
        (route.path !== '' && activePath.startsWith(`${route.path}/`));
      nav.appendChild(
        h(
          `a.nav-item${isActive ? '.active' : ''}`,
          { href: `#/${route.path}`, onclick: closeSidebar },
          icon(route.icon, 17),
          h('span', route.nav),
          navCount(route.path)
        )
      );
    }
  }
}

// Counts beside the nav items, from the stats already loaded for the dashboard.
function navCount(path) {
  if (!state.stats) return null;
  const counts = {
    library: state.stats.trackCount,
    albums: state.stats.albumCount,
    artists: state.stats.artistCount,
    playlists: state.stats.playlistCount,
  };
  const value = counts[path];
  return value ? h('span.nav-count', String(value)) : null;
}

// Shown permanently in the sidebar rather than buried in Settings: provider
// availability decides whether half the app can do anything at all, so it should
// never be a surprise.
const PROVIDER_LABELS = {
  deezer: 'Deezer',
  itunes: 'iTunes',
  musicbrainz: 'MusicBrainz',
};

function renderProviderPills() {
  const host = $('#provider-pills');
  clear(host);
  for (const [name, label] of Object.entries(PROVIDER_LABELS)) {
    const on = Boolean(state.providers?.[name]);
    // Only the active ones are named plainly. An "off" pill for every provider
    // someone has chosen not to use is noise, so those are dimmed and abridged.
    host.appendChild(badge(on ? label : `${label} off`, on ? 'ok' : undefined));
  }
}

function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
}

// The current view's own async work, cancelled when navigating away so a slow
// response cannot paint over the page the user has since moved to.
let viewToken = 0;

async function router() {
  if (!state.user) return;

  const matched = matchRoute(window.location.hash);
  if (!matched) {
    window.location.hash = '#/';
    return;
  }

  const { route, params } = matched;
  const token = ++viewToken;

  buildNav(route.path);
  $('#page-title').textContent = route.title;
  clear($('#page-actions'));

  const view = $('#view');
  window.scrollTo({ top: 0 });

  const context = {
    params,
    // A view calls this to check it is still the current one before painting.
    isCurrent: () => token === viewToken,
    // Replaces the topbar buttons rather than adding to them. Several views
    // re-run their own render function after a change (pairing a device, say),
    // and appending would stack a second copy of every button each time.
    setActions: (...nodes) => {
      if (token !== viewToken) return;
      mount($('#page-actions'), nodes);
    },
    setTitle: (title) => {
      if (token === viewToken) $('#page-title').textContent = title;
    },
    refreshStats: refreshStats,
    navigate: (path) => {
      window.location.hash = path.startsWith('#') ? path : `#/${path}`;
    },
  };

  try {
    await route.render(view, context);
  } catch (err) {
    if (err.status === 401) return;
    console.error('[view]', err);
    if (token === viewToken) {
      mount(view, h('div.notice.notice-danger', icon('warn', 16), h('div', err.message)));
    }
  }
}

export async function refreshStats() {
  try {
    state.stats = await api.stats();
    buildNav(matchRoute(window.location.hash)?.route.path ?? '');
  } catch {
    // Nav counts are decoration. A failure here must not break the page.
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function showApp() {
  $('#boot').hidden = true;
  $('#auth').hidden = true;
  $('#app').hidden = false;
}

function showAuth(needsSetup) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  const host = $('#auth');
  host.hidden = false;
  renderAuth(host, { needsSetup, onSignedIn: start });
}

async function start() {
  try {
    const [authState, health] = await Promise.all([
      api.state(),
      // Provider status is public on /api/health, so it is available on the
      // login screen too - useful, because "no provider is available" is the
      // first thing to know about a fresh instance.
      api.health().catch(() => ({ providers: {} })),
    ]);

    state.providers = health.providers || state.providers;

    if (!authState.user) {
      showAuth(authState.needsSetup);
      return;
    }

    state.user = authState.user;
    showApp();
    renderProviderPills();
    await refreshStats();
    await router();
  } catch (err) {
    mount(
      $('#boot'),
      h('div.notice.notice-danger', icon('warn', 16),
        h('div',
          h('strong', 'SyncMyPod could not start. '),
          h('span', err.message))),
      h('button.btn', { type: 'button', onclick: () => window.location.reload() }, 'Retry')
    );
  }
}

window.addEventListener('hashchange', router);

// Raised by api.js on any 401. One handler, rather than every call site.
window.addEventListener('syncmypod:unauthorised', () => {
  if (!state.user) return;
  state.user = null;
  toast('Your session has ended. Please sign in again.', 'info');
  showAuth(false);
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    // Even if the request fails, the local session is over as far as the user
    // is concerned - show the login screen rather than trapping them.
  }
  state.user = null;
  state.stats = null;
  window.location.hash = '#/';
  showAuth(false);
});

$('#nav-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

start();
