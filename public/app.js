import { parseImageRef, parseLaunchpadCommands } from '/lib/commands.js';

// ---------- small helpers ----------
const $ = (selector, root = document) => root.querySelector(selector);
const enc = encodeURIComponent;

/** Build a DOM node. Text always goes in as text, never as markup. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12|M18 6L6 18',
  alert: 'M12 4.5l8.5 15h-17z|M12 10.5v4|M12 17.3v.2',
  minus: 'M7 12h10',
  copy: 'M9 9h10.5v11.500H9z|M5 15V4.500h10',
  external: 'M13.500 5H19v5.500|M19 5l-8.500 8.500|M17 14v5H5V7h5',
  key: 'M20 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0z|M13.200 10.800L4 20|M6.500 17.500l2.500 2.500',
  folder: 'M3.500 7.500a1 1 0 0 1 1-1H9l2 2h8.500a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4z|M4 8l8 4 8-4|M12 12v8',
  play: 'M8 5.500l10.500 6.500L8 18.500z',
  stop: 'M7.500 7.500h9v9h-9z',
  down: 'M12 5v13|M6.500 12.500L12 18l5.500-5.500',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name].split('|')) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Liftoff is not answering. Is it still running?');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Something went wrong (${response.status})`);
    error.fields = data.fields;
    throw error;
  }
  return data;
}

function toast(message, failed = false) {
  const node = el('div', { class: `toast${failed ? ' is-fail' : ''}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), failed ? 6000 : 2200);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(label);
}

const copyButton = (text, label) => el('button', { class: 'copy', type: 'button', title: 'Copy', 'aria-label': 'Copy', onclick: (event) => { event.stopPropagation(); copyText(text, label); } }, icon('copy'));

function timeAgo(isoTime) {
  if (!isoTime) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(isoTime)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86400 * 14) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(isoTime).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function clock(isoTime) {
  if (!isoTime) return '';
  const date = new Date(isoTime);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

function duration(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function bytes(value) {
  if (value === undefined || value === null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit++;
  }
  return `${unit === 0 ? amount : amount.toFixed(amount < 10 ? 2 : 1)} ${units[unit]}`;
}

const shortDigest = (digest) => (digest ? digest.replace(/^sha256:/, '').slice(0, 12) : '');

// ---------- state ----------
const STEP_LABEL = { preflight: 'Checks', login: 'Login', build: 'Build', push: 'Push', verify: 'Verify' };

const state = {
  apps: [],
  meta: null,
  loaded: false,
  offline: false,
  view: 'app',   // 'app' or 'queue'
  queue: { file: '', folder: '', error: null, entries: [] }, // the queue file as the server reads it, newest entry first
  movingQueue: false,
  appId: null,
  deployments: [],
  deploymentId: null,
  followLatest: true,
  record: null,
  noCache: false,
  login: {},     // appId -> { loading } | { ok, message }
  registry: {},  // appId -> { loading } | registry answer
  health: {},    // appId -> { loading } | health answer
};

let stream = null;
let logState = { step: null, count: 0 };
const main = $('#main');
const currentApp = () => state.apps.find((app) => app.id === state.appId) ?? null;
/** Waiting for its turn, or running. */
const isLive = (record) => record?.status === 'queued' || record?.status === 'running';

/** Replace a region's contents only when what it shows has changed, so focus and hover survive the polling. */
function update(node, signature, build) {
  if (!node) return;
  const key = JSON.stringify(signature);
  if (node.dataset.sig === key) return;
  node.dataset.sig = key;
  node.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
}

function describeStatus(record) {
  if (!record) return { tone: 'idle', dot: '', label: 'Never deployed' };
  if (record.status === 'queued') return { tone: 'run', dot: 'dot-wait', label: 'Waiting in queue' };
  if (record.status === 'running') {
    const step = record.steps.find((candidate) => candidate.status === 'running');
    return { tone: 'run', dot: 'dot-run', label: step ? `${STEP_LABEL[step.key]} running` : 'Deploying' };
  }
  if (record.status === 'succeeded') {
    return record.verify?.status === 'verified'
      ? { tone: 'ok', dot: 'dot-ok', label: 'Verified' }
      : { tone: 'warn', dot: 'dot-warn', label: 'Pushed, not confirmed' };
  }
  if (record.status === 'cancelled') return { tone: 'warn', dot: 'dot-warn', label: 'Cancelled' };
  const step = record.steps.find((candidate) => candidate.status === 'failed');
  return { tone: 'fail', dot: 'dot-fail', label: step ? `Failed at ${STEP_LABEL[step.key].toLowerCase()}` : 'Failed' };
}

// ---------- top bar and sidebar ----------
function renderTopbar() {
  const { meta, offline } = state;
  update($('#topbar-status'), [meta?.docker, meta?.vault, offline], () => {
    if (offline) return el('span', { class: 'pill' }, el('span', { class: 'dot dot-fail' }), 'Liftoff is not answering');
    if (!meta) return [];
    const engine = meta.docker ?? { ok: false, error: 'checking' };
    return [
      el('span', { class: 'pill', title: engine.ok ? `Docker engine ${engine.server}, client ${engine.client}` : `Docker: ${engine.error}` },
        el('span', { class: `dot ${engine.ok ? 'dot-ok' : 'dot-fail'}` }),
        engine.ok ? `Docker ${engine.server}` : 'Docker is not running'),
      el('span', { class: 'pill', title: `Passwords: ${meta.vault.label}.\nData folder: ${meta.home}` },
        el('span', { class: 'dot dot-ok' }),
        el('span', { class: 'pill-long' }, 'Passwords '),
        meta.vault.backend === 'dpapi' ? 'encrypted by Windows' : 'obscured with a key file'),
    ];
  });
}

function renderSidebar() {
  const minute = Math.floor(Date.now() / 60000);
  const busy = state.meta?.queue ?? { running: 0, waiting: 0 };
  $('#queue-link').classList.toggle('is-selected', state.view === 'queue');
  $('#queue-dot').className = `dot ${busy.running ? 'dot-run' : busy.waiting ? 'dot-wait' : ''}`;
  $('#queue-meta').textContent = busy.running || busy.waiting ? `${busy.running} running · ${busy.waiting} waiting` : 'Nothing running or waiting';
  update($('#app-list'), [state.apps.map((app) => [app.id, app.name, app.last?.id, describeStatus(app.last).label]), state.appId, minute, state.loaded], () => {
    if (!state.apps.length) return el('li', { class: 'sidebar-empty', text: state.loaded ? 'No apps yet.' : 'Loading…' });
    return state.apps.map((app) => {
      const status = describeStatus(app.last);
      const meta = app.last ? `${status.label} · ${timeAgo(app.last.finishedAt ?? app.last.startedAt)}` : status.label;
      return el('li', null,
        el('a', { class: `app-item${app.id === state.appId ? ' is-selected' : ''}`, href: `#/apps/${enc(app.id)}`, 'aria-current': app.id === state.appId ? 'page' : null },
          el('span', { class: `dot ${status.dot}` }),
          el('span', { class: 'app-item-text' },
            el('span', { class: 'app-item-name' }, el('span', { class: 'app-num', title: 'Use this number for the app in the queue file', text: `${app.number} ` }), app.name),
            el('span', { class: 'app-item-meta', text: meta }))));
    });
  });
}

// ---------- app page ----------
function mountEmpty() {
  main.replaceChildren(el('div', { class: 'empty' },
    el('h1', { text: 'Deploy to Launchpad without typing the password' }),
    el('p', { text: 'Liftoff keeps each app’s push password encrypted on this computer and runs login, build, push and a registry check for you. Every deploy is kept in a history.' }),
    el('button', { class: 'btn btn-primary btn-large', type: 'button', onclick: () => openAppDialog() }, 'Add your first app'),
    el('ol', { class: 'steps' },
      el('li', null, el('b', { text: '1' }), el('span', { text: 'Paste the three docker commands Launchpad shows for your app.' })),
      el('li', null, el('b', { text: '2' }), el('span', { text: 'Enter the push password once and point to the folder with the Dockerfile.' })),
      el('li', null, el('b', { text: '3' }), el('span', { text: 'Press Deploy. From then on it is one click, or one command in a terminal.' })))));
}

function mountAppPage() {
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { id: 'r-head' }),
    el('div', { id: 'r-banner' }),
    el('div', { class: 'cards', id: 'r-cards' }),
    el('section', { class: 'panel', id: 'r-run', 'aria-label': 'Deploy' }),
    el('section', { class: 'panel', id: 'r-history', 'aria-label': 'History' }),
    el('div', { class: 'cli', id: 'r-cli' })));
  // The run panel keeps its log element across updates, so it is built once.
  $('#r-run').replaceChildren(
    el('div', { class: 'panel-head', id: 'run-head' }),
    el('div', { class: 'panel-body', id: 'run-body' },
      el('ol', { class: 'stages', id: 'run-stages' }),
      el('div', { id: 'run-callout' }),
      el('dl', { class: 'facts', id: 'run-facts' }),
      el('div', { class: 'log-wrap' },
        el('div', { class: 'log-bar' },
          el('span', { id: 'log-status', text: 'Output' }),
          el('span', null,
            el('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: copyLog }, icon('copy'), 'Copy log'),
            el('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { const box = $('#log'); box.scrollTop = box.scrollHeight; } }, icon('down'), 'Latest'))),
        el('div', { class: 'log', id: 'log', tabindex: '0', role: 'log', 'aria-label': 'Deploy output' }))),
    el('div', { class: 'panel-empty', id: 'run-empty', hidden: true }));
}

function setupIssues(app) {
  const issues = [];
  if (!app.hasPassword) issues.push({ text: 'The push password is not stored yet.', action: 'Set password', run: () => openPasswordDialog(app) });
  if (!app.folder.exists) issues.push({ text: `The source folder was not found: ${app.contextDir}`, action: 'Edit app', run: () => openAppDialog(app) });
  else if (!app.folder.hasDockerfile) issues.push({ text: `There is no ${app.dockerfile || 'Dockerfile'} in ${app.contextDir}`, action: 'Edit app', run: () => openAppDialog(app) });
  if (state.meta?.docker && !state.meta.docker.ok) issues.push({ text: 'Docker is not running. Start Docker Desktop before deploying.' });
  return issues;
}

function renderHead(app) {
  const busy = (state.meta?.queue?.running ?? 0) + (state.meta?.queue?.waiting ?? 0) > 0;
  const blocked = !app.hasPassword || !app.folder.exists || !app.folder.hasDockerfile;
  const health = state.health[app.id];
  update($('#r-head'), [app.name, app.image, app.liveUrl, busy, blocked, health, state.noCache], () => {
    let live = null;
    if (app.liveUrl) {
      const tone = !health || health.loading ? '' : health.ok ? 'dot-ok' : 'dot-fail';
      const text = !health || health.loading ? 'checking…'
        : health.status ? `answers ${health.status} in ${health.ms} ms` : `not answering (${health.message})`;
      live = el('span', { class: 'live' },
        el('span', { class: `dot ${tone}` }),
        el('a', { href: app.liveUrl, target: '_blank', rel: 'noopener noreferrer', text: new URL(app.liveUrl).host }),
        el('button', { class: 'btn btn-quiet btn-small', type: 'button', title: 'Check again', onclick: () => checkHealth(app.id), text }));
    }
    return el('div', { class: 'app-head' },
      el('div', { class: 'app-title' },
        el('h1', { text: app.name }),
        el('div', { class: 'app-sub' },
          el('span', null, el('span', { class: 'mono', text: app.image }), ' ', copyButton(app.image, 'Image name copied')),
          live)),
      el('div', { class: 'app-actions' },
        el('label', { class: 'deploy-options', title: 'Rebuild every layer instead of reusing cached ones' },
          el('input', { type: 'checkbox', checked: state.noCache, onchange: (event) => { state.noCache = event.target.checked; } }),
          'Skip build cache'),
        el('button', { class: 'btn', type: 'button', onclick: () => openAppDialog(app) }, 'Edit'),
        el('button', { class: 'btn btn-primary btn-large', type: 'button', id: 'deploy', disabled: blocked, onclick: deploy, title: busy ? 'Another deploy is running; this one will wait its turn' : null },
          icon('play'), busy ? 'Add to queue' : 'Deploy')));
  });
}

function renderBanner(app) {
  const issues = setupIssues(app);
  update($('#r-banner'), issues.map((issue) => issue.text), () => {
    if (!issues.length) return [];
    return el('div', { class: 'banner', role: 'status' }, issues.map((issue) => el('div', { class: 'banner-row' },
      icon('alert'),
      el('span', { text: issue.text }),
      issue.action ? el('button', { class: 'btn btn-small', type: 'button', onclick: issue.run, text: issue.action }) : null)));
  });
}

function renderCards(app) {
  const login = state.login[app.id];
  const registry = state.registry[app.id];
  const lastGood = state.deployments.find((record) => record.digest && record.status === 'succeeded');
  const source = state.deployments.find((record) => record.git)?.git;
  const minute = Math.floor(Date.now() / 60000);
  const shown = [app.id, app.username, app.hasPassword, app.passwordSavedAt, app.contextDir, app.dockerfile, app.platform, app.tag, app.folder];
  update($('#r-cards'), [shown, login, registry, lastGood?.id, source, minute], () => {
    // --- push login
    const loginCard = el('div', { class: 'card' },
      el('div', { class: 'card-title eyebrow' }, icon('key'), 'Push login'),
      el('div', { class: 'card-value mono', text: app.username }),
      el('div', { class: `card-meta ${app.hasPassword ? '' : 'is-warn'}`, text: app.hasPassword ? `Password stored encrypted · saved ${timeAgo(app.passwordSavedAt)}` : 'No password stored' }),
      login && !login.loading ? el('div', { class: `card-meta ${login.ok ? 'is-ok' : 'is-fail'}`, text: login.message }) : null,
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn btn-small', type: 'button', onclick: () => openPasswordDialog(app), text: app.hasPassword ? 'Replace password' : 'Set password' }),
        el('button', { class: 'btn btn-small', type: 'button', disabled: !app.hasPassword || login?.loading, onclick: () => runLoginTest(app.id), text: login?.loading ? 'Testing…' : 'Test login' })));

    // --- source
    const folderOk = app.folder.exists && app.folder.hasDockerfile;
    const sourceCard = el('div', { class: 'card' },
      el('div', { class: 'card-title eyebrow' }, icon('folder'), 'Source'),
      el('div', { class: 'card-value mono', text: app.contextDir }),
      el('div', { class: `card-meta ${folderOk ? '' : 'is-warn'}`, text: !app.folder.exists ? 'Folder not found' : app.folder.hasDockerfile ? `${app.dockerfile || 'Dockerfile'} found · builds for ${app.platform}` : `No ${app.dockerfile || 'Dockerfile'} in this folder` }),
      source ? el('div', { class: 'card-meta', text: `Last deployed from ${source.branch ?? 'a detached commit'} @ ${source.commit}${source.dirty ? ` with ${source.dirty} uncommitted change${source.dirty === 1 ? '' : 's'}` : ''}` }) : null,
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn btn-small', type: 'button', onclick: () => { openAppDialog(app); $('#f-contextDir').focus(); $('#f-contextDir').select(); }, text: 'Change folder' })));

    // --- registry
    let value = 'Nothing pushed yet';
    const notes = [];
    if (registry && !registry.loading && registry.ok) {
      if (registry.found) {
        value = `${app.tag} → ${shortDigest(registry.digest)}`;
        notes.push(registry.deployment
          ? { text: `Same image as deploy #${registry.deployment.number}`, tone: 'is-ok' }
          : { text: 'This image was not pushed from here', tone: 'is-warn' });
      } else {
        value = `No ${app.tag} tag in the registry`;
      }
      if (registry.tags?.length > 1) notes.push({ text: `${registry.tags.length} tags: ${registry.tags.slice(0, 6).join(', ')}${registry.tags.length > 6 ? '…' : ''}` });
      notes.push({ text: `Checked ${timeAgo(registry.checkedAt)}` });
    } else if (registry && !registry.loading) {
      if (lastGood) value = `${app.tag} → ${shortDigest(lastGood.digest)}`;
      notes.push({ text: registry.message, tone: 'is-fail' });
    } else if (lastGood) {
      value = `${app.tag} → ${shortDigest(lastGood.digest)}`;
      notes.push({ text: `As of deploy #${lastGood.number}, ${timeAgo(lastGood.finishedAt)}` });
    }
    const registryCard = el('div', { class: 'card' },
      el('div', { class: 'card-title eyebrow' }, icon('box'), 'Registry'),
      el('div', { class: 'card-value mono', text: value }),
      notes.map((note) => el('div', { class: `card-meta ${note.tone ?? ''}`, text: note.text })),
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn btn-small', type: 'button', disabled: !app.hasPassword || registry?.loading, onclick: () => checkRegistry(app.id), text: registry?.loading ? 'Checking…' : 'Check now' })));

    return [loginCard, sourceCard, registryCard];
  });
}

function stageIcon(status) {
  if (status === 'ok') return icon('check');
  if (status === 'failed') return icon('x');
  if (status === 'warn') return icon('alert');
  if (status === 'cancelled') return icon('stop');
  if (status === 'skipped') return icon('minus');
  return null;
}

function renderRun() {
  const record = state.record;
  const app = currentApp();
  const head = $('#run-head');
  if (!head || !app) return;
  $('#run-body').hidden = !record;
  $('#run-empty').hidden = Boolean(record);
  if (!record) {
    update(head, 'none', () => el('div', { class: 'panel-title' }, el('h2', { text: 'Deploys' })));
    update($('#run-empty'), 'empty', () => 'Nothing deployed from here yet. Deploy builds the image, pushes it, and checks that the registry has it.');
    return;
  }

  const running = record.status === 'running';
  const waiting = record.status === 'queued';
  const status = describeStatus(record);
  // Running clocks are spans marked data-since; tickClocks() rewrites their text every second,
  // so the buttons around them are not rebuilt under the pointer.
  const since = (isoTime) => el('span', { 'data-since': isoTime, text: duration(Date.now() - Date.parse(isoTime)) });

  update(head, [record.id, record.status, record.verify?.status, status.label, record.durationMs, state.cancelling === record.id], () => [
    el('div', { class: 'panel-title' },
      el('h2', { text: `Deploy #${record.number}` }),
      el('span', { class: `badge badge-${status.tone}` }, status.tone === 'ok' ? icon('check') : null, status.label),
      el('span', { class: 'panel-meta' },
        `${clock(record.queuedAt ?? record.startedAt)} · `,
        running ? since(record.startedAt) : waiting ? 'not started yet' : duration(record.durationMs),
        ` · started from ${record.trigger === 'cli' ? 'a terminal' : 'this app'}`)),
    el('div', { class: 'panel-actions' },
      running || waiting ? el('button', { class: 'btn btn-small', type: 'button', disabled: state.cancelling === record.id, onclick: () => cancelDeploy(record) }, icon('stop'), state.cancelling === record.id ? 'Cancelling…' : 'Cancel') : null),
  ]);

  update($('#run-stages'), [record.id, record.steps.map((step) => [step.status, step.durationMs])], () => record.steps.map((step) => {
    const time = step.status === 'running' ? since(step.startedAt)
      : step.status === 'skipped' ? 'skipped'
        : step.durationMs !== undefined ? duration(step.durationMs) : '';
    return el('li', { class: `stage is-${step.status}` },
      el('button', { class: 'stage-button', type: 'button', title: `Show the ${STEP_LABEL[step.key].toLowerCase()} output`, onclick: () => document.getElementById(`log-step-${step.key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) },
        el('span', { class: 'stage-node' }, stageIcon(step.status)),
        el('span', { class: 'stage-name', text: STEP_LABEL[step.key] }),
        el('span', { class: 'stage-time' }, time)));
  }));

  update($('#run-callout'), [record.id, record.status, record.error, record.verify], () => {
    if (waiting) return el('div', { class: 'callout callout-idle' }, icon('minus'), el('span', { class: 'callout-text', text: 'Waiting for the deploy ahead of it to finish. It starts by itself; the Queue page shows the order.' }));
    if (record.status === 'cancelled' && record.steps.every((step) => step.status === 'skipped')) {
      return el('div', { class: 'callout callout-warn' }, icon('stop'), el('span', { class: 'callout-text', text: 'Cancelled while it was waiting in the queue. It never started.' }));
    }
    if (record.status === 'failed') return el('div', { class: 'callout callout-fail', role: 'alert' }, icon('alert'), el('span', { class: 'callout-text', text: record.error }));
    if (record.status === 'cancelled') {
      const push = record.steps.find((step) => step.key === 'push')?.status;
      const text = push === 'ok'
        ? 'Cancelled during verification. The image had already been pushed, so Launchpad will pick it up.'
        : push === 'cancelled'
          ? 'Cancelled while pushing. The tag normally stays on the previous image; “Check now” on the Registry card shows what the registry holds.'
          : 'Cancelled before anything was pushed. The registry still has the previous image.';
      return el('div', { class: 'callout callout-warn' }, icon('stop'), el('span', { class: 'callout-text', text }));
    }
    if (record.status === 'succeeded' && record.verify?.status === 'verified') {
      return el('div', { class: 'callout callout-ok' }, icon('check'), el('span', { class: 'callout-text', text: `${app.registry} now serves this image as ${app.repository}:${app.tag}. Launchpad picks it up from here.` }));
    }
    if (record.status === 'succeeded') {
      return el('div', { class: 'callout callout-warn' }, icon('alert'), el('span', { class: 'callout-text', text: `The push succeeded, but the registry could not be asked to confirm it: ${record.verify?.detail ?? 'unknown reason'}` }));
    }
    return [];
  });

  update($('#run-facts'), [record.id, record.digest, record.imageSize, record.builtPlatform, record.git, record.options, record.command], () => {
    const facts = [];
    if (record.command) facts.push(['Command', el('span', { class: 'mono', text: `liftoff ${record.command}` })]);
    if (record.digest) facts.push(['Pushed image', [el('span', { class: 'mono', title: record.digest, text: shortDigest(record.digest) }), ' ', copyButton(record.digest, 'Digest copied')]]);
    if (record.imageSize !== undefined) facts.push(['Size', `${bytes(record.imageSize)} · ${record.builtPlatform}`]);
    if (record.git) facts.push(['Source', [el('span', { class: 'mono', text: `${record.git.branch ?? 'detached'} @ ${record.git.commit}` }), record.git.dirty ? ` + ${record.git.dirty} uncommitted` : '']]);
    if (record.git?.subject) facts.push(['Last commit', record.git.subject]);
    if (record.options?.noCache) facts.push(['Build cache', 'Skipped']);
    return facts.map(([name, value]) => el('div', { class: 'fact' }, el('dt', { text: name }), el('dd', null, value)));
  });
}

function renderHistory() {
  const minute = Math.floor(Date.now() / 60000);
  $('#r-history').hidden = !state.deployments.length;
  update($('#r-history'), [state.deployments.map((record) => [record.id, record.status, record.verify?.status, record.durationMs, record.digest]), state.deploymentId, minute], () => {
    if (!state.deployments.length) return [];
    return [
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, el('h2', { text: 'History' }), el('span', { class: 'panel-meta', text: `${state.deployments.length} deploy${state.deployments.length === 1 ? '' : 's'} kept on this computer` }))),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['#', 'Result', 'Started', 'Took', 'Image', 'Source'].map((title) => el('th', { text: title })))),
        el('tbody', null, state.deployments.map((record) => {
          const status = describeStatus(record);
          const select = () => { location.hash = `#/apps/${enc(record.appId)}/d/${enc(record.id)}`; };
          return el('tr', { class: record.id === state.deploymentId ? 'is-selected' : '', tabindex: '0', onclick: select, onkeydown: (event) => { if (event.key === 'Enter') select(); } },
            el('td', { class: 'num', text: `#${record.number}` }),
            el('td', null, el('span', { class: 'status' }, el('span', { class: `dot ${status.dot}` }), status.label)),
            el('td', { text: clock(record.startedAt), title: new Date(record.startedAt).toLocaleString() }),
            el('td', { class: 'num', text: record.status === 'running' ? '' : duration(record.durationMs) }),
            el('td', { class: 'mono', text: shortDigest(record.digest) || '–', title: record.digest ?? '' }),
            el('td', { class: 'mono', text: record.git ? `${record.git.commit}${record.git.dirty ? ' +' : ''}` : '–', title: record.git?.subject ?? '' }));
        })))),
    ];
  });
}

function renderCli(app) {
  update($('#r-cli'), [app.id, state.meta?.cli], () => {
    if (!state.meta?.cli) return [];
    const command = `${state.meta.cli} deploy ${app.id}`;
    return [el('span', { class: 'cli-label', text: 'From a terminal or a script:' }), el('code', { text: command }), copyButton(command, 'Command copied')];
  });
}

// ---------- queue page ----------
const ENTRY_STATUS = {
  new: { dot: 'dot-wait', label: 'Not started yet' },
  waiting: { dot: 'dot-wait', label: 'Waiting' },
  running: { dot: 'dot-run', label: 'Running' },
  verified: { dot: 'dot-ok', label: 'Verified' },
  pushed: { dot: 'dot-warn', label: 'Pushed, not confirmed' },
  failed: { dot: 'dot-fail', label: 'Failed' },
  cancelled: { dot: 'dot-warn', label: 'Cancelled' },
  rejected: { dot: 'dot-fail', label: 'Not accepted' },
};

function mountQueue() {
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'app-head' }, el('div', { class: 'app-title' },
      el('h1', { text: 'Queue' }),
      el('div', { class: 'app-sub', text: 'This page shows the queue file. Add an entry to the end of the file and save: the deploy starts by itself. One runs at a time.' }))),
    el('div', { class: 'card', id: 'r-queue-file' }),
    el('div', { class: 'card', id: 'r-queue-add' }),
    el('div', { id: 'r-queue-error' }),
    el('section', { class: 'panel', id: 'r-queue', 'aria-label': 'Queue' })));
}

/** The Add entry form on the Queue page: the same as typing the entry into the file. */
async function addQueueEntry(event) {
  event.preventDefault();
  const form = event.target;
  const body = {};
  if (form.elements.app.value) body.app = Number(form.elements.app.value);
  if (form.elements.src.value.trim()) body.src = form.elements.src.value.trim();
  if (form.elements.noCache.checked) body.noCache = true;
  const button = form.querySelector('button[type="submit"]');
  const problem = $('#queue-add-error');
  button.disabled = true;
  problem.textContent = '';
  try {
    await api('POST', '/api/queue', body);
    form.elements.src.value = '';
    form.elements.noCache.checked = false;
    toast('Entry added. Its deploy is starting.');
    await refresh();
  } catch (error) {
    problem.textContent = error.fields ? Object.values(error.fields)[0] : error.message;
  } finally {
    button.disabled = false;
  }
}

async function moveQueueFile(event) {
  event.preventDefault();
  const input = $('#queue-path');
  try {
    state.queue = await api('PUT', '/api/queue-file', { path: input.value });
    state.movingQueue = false;
    toast('Queue file moved');
  } catch (error) {
    toast(error.fields?.queueFile ?? error.message, true);
  }
  renderAll();
}

function renderQueue() {
  const view = state.queue;
  const minute = Math.floor(Date.now() / 60000);

  update($('#r-queue-file'), [view.file, view.watching, state.movingQueue, state.apps.map((app) => [app.number, app.name])], () => {
    const first = state.apps[0];
    const example = `{ "app": ${first?.number ?? 1}, "src": "my-project" }`;
    return [
      el('div', { class: 'card-title eyebrow' }, icon('folder'), 'Queue file'),
      state.movingQueue
        ? el('form', { class: 'input-with-button', onsubmit: moveQueueFile },
          el('input', { type: 'text', class: 'mono', id: 'queue-path', value: view.file, spellcheck: 'false', 'aria-label': 'Queue file path' }),
          el('button', { class: 'btn btn-small btn-primary', type: 'submit', text: 'Use this file' }),
          el('button', { class: 'btn btn-small', type: 'button', text: 'Cancel', onclick: () => { state.movingQueue = false; renderAll(); } }))
        : el('div', { class: 'card-value mono' }, view.file, ' ', copyButton(view.file, 'Path copied')),
      el('div', { class: 'card-meta' }, 'To deploy, add a line like ', el('span', { class: 'mono', text: example }), ' ', copyButton(example, 'Entry copied'), ' to the end of the list and save. To deploy again, add another one.'),
      el('div', { class: 'card-meta', text: `"app" is the app's number${state.apps.length ? `: ${[...state.apps].sort((a, b) => a.number - b.number).map((app) => `${app.number} = ${app.name}`).join(', ')}` : ''}. "src" is the source folder, starting from ${view.folder || 'the queue file’s folder'}; a full path works too, and without "src" the app keeps its folder. Leave "app" out, as in { "src": "my-project" }, and Liftoff picks an available app.` }),
      view.watching === false ? el('div', { class: 'card-meta is-warn', text: 'Another Liftoff on this computer is watching this file and starts the new entries.' }) : null,
      state.movingQueue ? null : el('div', { class: 'card-actions' },
        el('button', { class: 'btn btn-small', type: 'button', text: 'Move the file…', onclick: () => { state.movingQueue = true; renderAll(); $('#queue-path')?.focus(); } })),
    ];
  });

  // Built only when the list of apps or the folder changes, so what is being typed is not wiped by the refresh.
  const numbered = [...state.apps].sort((a, b) => a.number - b.number);
  update($('#r-queue-add'), [numbered.map((app) => [app.number, app.name]), view.folder], () => {
    if (!numbered.length) return [el('div', { class: 'card-title eyebrow' }, icon('play'), 'Add entry'), el('div', { class: 'card-meta', text: 'Add an app first; then entries can be added here.' })];
    return [
      el('div', { class: 'card-title eyebrow' }, icon('play'), 'Add entry'),
      el('form', { class: 'queue-add', onsubmit: addQueueEntry },
        el('div', { class: 'field' },
          el('label', { for: 'qa-app', text: 'App' }),
          el('select', { id: 'qa-app', name: 'app' }, el('option', { value: '', text: 'Any available app' }), numbered.map((app) => el('option', { value: String(app.number), text: `${app.number}  ${app.name}` })))),
        el('div', { class: 'field queue-add-src' },
          el('label', { for: 'qa-src', text: 'Source folder' }),
          el('input', { id: 'qa-src', name: 'src', type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'my-project, or https://github.com/owner/repo' })),
        el('label', { class: 'deploy-options' }, el('input', { type: 'checkbox', name: 'noCache' }), 'Skip build cache'),
        el('button', { class: 'btn btn-primary', type: 'submit' }, icon('play'), 'Add and deploy')),
      el('div', { class: 'card-meta', text: `Writes the entry to the end of the queue file and starts its deploy. A short folder name starts from ${view.folder || 'the queue file’s folder'}.` }),
      el('div', { class: 'card-meta', text: `Source folder: empty keeps the app’s folder. A repository address is cloned into ${view.folder || 'the queue file’s folder'} first; a copy that is already there is used as it is.` }),
      el('div', { class: 'card-meta', text: '“Any available app” needs a folder. It goes to the app that already deploys that folder, otherwise to an app that has never been deployed. An app serving another project is never taken over.' }),
      el('div', { class: 'field-error', id: 'queue-add-error', role: 'alert' }),
    ];
  });

  update($('#r-queue-error'), view.error, () => (view.error
    ? el('div', { class: 'callout callout-fail', role: 'alert' }, icon('alert'), el('span', { class: 'callout-text', text: view.error }))
    : []));

  update($('#r-queue'), [view.entries, minute], () => {
    if (!view.entries.length) return el('div', { class: 'panel-empty', text: 'The queue file has no entries yet.' });
    return el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Status', 'App', 'Folder', 'Asked', 'Took', 'Image', 'Address'].map((title) => el('th', { text: title })))),
      el('tbody', null, view.entries.map((entry) => {
        const status = ENTRY_STATUS[entry.status] ?? { dot: '', label: String(entry.status) };
        const linked = entry.appId && entry.id;
        const open = () => { if (linked) location.hash = `#/apps/${enc(entry.appId)}/d/${enc(entry.id)}`; };
        return el('tr', { tabindex: linked ? '0' : null, class: linked ? '' : 'is-plain', onclick: open, onkeydown: (event) => { if (event.key === 'Enter') open(); } },
          el('td', null, el('span', { class: 'status' }, el('span', { class: `dot ${status.dot}` }), status.label)),
          el('td', null, el('span', { class: 'app-num', text: typeof entry.app === 'number' ? `${entry.app} ` : '' }), entry.appName ?? String(entry.app ?? '–'), entry.deploy ? ` #${entry.deploy}` : ''),
          el('td', { class: 'command' }, el('span', { class: 'mono', text: (entry.src ?? '–').replace(/^https?:\/\/(www\.)?/, '') }), entry.noCache ? ' · no cache' : '', entry.error ? el('div', { class: 'entry-error', text: entry.error }) : null),
          el('td', { text: entry.asked ? clock(entry.asked.replace(' ', 'T')) : '–', title: entry.asked ?? '' }),
          el('td', { class: 'num', text: entry.took ?? '–' }),
          el('td', { class: 'mono', text: shortDigest(entry.image) || '–', title: entry.image ?? '' }),
          el('td', null, entry.url
            ? [el('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer', text: new URL(entry.url).host, onclick: (event) => event.stopPropagation() }), ' ', copyButton(entry.url, 'Address copied')]
            : '–'));
      }))));
  });
}

async function loadQueue() {
  try {
    state.queue = await api('GET', '/api/queue');
  } catch { /* keep what is shown */ }
}

async function selectQueue() {
  closeStream();
  Object.assign(state, { view: 'queue', appId: null, deployments: [], deploymentId: null, record: null });
  mountQueue();
  renderAll();
  await loadQueue();
  renderAll();
}

function renderAll() {
  renderTopbar();
  renderSidebar();
  if (state.view === 'queue') {
    renderQueue();
    return;
  }
  const app = currentApp();
  if (!app) return;
  renderHead(app);
  renderBanner(app);
  renderCards(app);
  renderRun();
  renderHistory();
  renderCli(app);
}

// ---------- deploy output ----------
function resetLog() {
  const box = $('#log');
  if (box) box.replaceChildren();
  logState = { step: null, count: 0 };
}

const LOG_LIMIT = 8000;

function appendLogs(entries) {
  const box = $('#log');
  if (!box) return;
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    if (entry.step !== logState.step) {
      logState.step = entry.step;
      fragment.append(el('div', { class: 'log-step', id: `log-step-${entry.step}`, text: STEP_LABEL[entry.step] ?? entry.step }));
    }
    fragment.append(el('div', { class: `line line-${entry.s}`, text: entry.m }));
    logState.count++;
  }
  box.append(fragment);
  if (box.childElementCount > LOG_LIMIT) {
    while (box.childElementCount > LOG_LIMIT - 1000) box.firstElementChild.remove();
    box.prepend(el('div', { class: 'log-note', text: 'Earlier output is not shown here. “Copy log” copies all of it.' }));
  }
  if (atEnd) box.scrollTop = box.scrollHeight;
  const status = $('#log-status');
  if (status) status.textContent = `Output · ${logState.count.toLocaleString()} lines`;
}

async function copyLog() {
  if (!state.record) return;
  try {
    const response = await fetch(`/api/apps/${enc(state.record.appId)}/deployments/${enc(state.record.id)}/log.txt`);
    await copyText(await response.text(), 'Log copied');
  } catch {
    toast('Could not copy the log', true);
  }
}

function closeStream() {
  stream?.close();
  stream = null;
}

function showDeployment(id) {
  if (id === state.deploymentId && (stream || !isLive(state.record))) {
    renderRun();
    renderHistory();
    return;
  }
  closeStream();
  state.deploymentId = id;
  state.record = state.deployments.find((record) => record.id === id) ?? null;
  resetLog();
  renderRun();
  renderHistory();
  if (id) openStream(state.appId, id);
}

function openStream(appId, id) {
  const source = new EventSource(`/api/apps/${enc(appId)}/deployments/${enc(id)}/stream`);
  stream = source;
  const mine = () => stream === source;
  source.addEventListener('logs', (event) => mine() && appendLogs(JSON.parse(event.data)));
  source.addEventListener('record', (event) => {
    if (!mine()) return;
    const record = JSON.parse(event.data);
    state.record = record;
    const index = state.deployments.findIndex((candidate) => candidate.id === record.id);
    if (index !== -1) state.deployments[index] = record;
    const app = state.apps.find((candidate) => candidate.id === record.appId);
    if (app?.last?.id === record.id) app.last = record;
    renderAll();
  });
  source.addEventListener('end', () => {
    source.close();
    if (!mine()) return;
    stream = null;
    refresh();
    if (currentApp()?.liveUrl) setTimeout(() => checkHealth(appId), 1500);
  });
  source.addEventListener('fail', () => {
    source.close();
    if (mine()) stream = null;
  });
  source.onerror = () => {
    // The browser would reconnect by itself and replay the output from the start; do it deliberately instead.
    source.close();
    if (!mine()) return;
    stream = null;
    setTimeout(() => {
      if (state.deploymentId === id && !stream && isLive(state.record)) {
        resetLog();
        openStream(appId, id);
      }
    }, 1500);
  };
}

// ---------- actions ----------
async function deploy() {
  const app = currentApp();
  if (!app) return;
  try {
    const busy = (state.meta?.queue?.running ?? 0) + (state.meta?.queue?.waiting ?? 0) > 0;
    const { deployment } = await api('POST', `/api/apps/${enc(app.id)}/deploy`, { noCache: state.noCache });
    if (busy) toast('Added to the queue. It starts when the deploy ahead of it is done.');
    state.deployments.unshift(deployment);
    app.last = deployment;
    state.followLatest = true;
    if (location.hash !== `#/apps/${enc(app.id)}`) history.replaceState(null, '', `#/apps/${enc(app.id)}`);
    showDeployment(deployment.id);
    renderAll();
    $('#r-run').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (error) {
    toast(error.message, true);
  }
}

async function cancelDeploy(record) {
  state.cancelling = record.id;
  renderRun();
  try {
    await api('POST', `/api/apps/${enc(record.appId)}/deployments/${enc(record.id)}/cancel`);
  } catch (error) {
    state.cancelling = null;
    toast(error.message, true);
  }
}

async function runLoginTest(appId) {
  state.login[appId] = { loading: true };
  renderAll();
  try {
    state.login[appId] = await api('POST', `/api/apps/${enc(appId)}/test-login`);
  } catch (error) {
    state.login[appId] = { ok: false, message: error.message };
  }
  renderAll();
}

async function checkRegistry(appId) {
  state.registry[appId] = { loading: true };
  renderAll();
  try {
    state.registry[appId] = await api('GET', `/api/apps/${enc(appId)}/registry`);
  } catch (error) {
    state.registry[appId] = { ok: false, message: error.message };
  }
  renderAll();
}

async function checkHealth(appId) {
  const app = state.apps.find((candidate) => candidate.id === appId);
  if (!app?.liveUrl) return;
  state.health[appId] = { loading: true };
  renderAll();
  try {
    state.health[appId] = await api('GET', `/api/apps/${enc(appId)}/health`);
  } catch (error) {
    state.health[appId] = { ok: false, message: error.message };
  }
  renderAll();
}

// ---------- loading and routing ----------
async function loadDeployments() {
  const appId = state.appId;
  const data = await api('GET', `/api/apps/${enc(appId)}/deployments`);
  if (appId === state.appId) state.deployments = data.deployments;
}

async function selectApp(appId, deploymentId) {
  if (appId && !state.apps.some((app) => app.id === appId)) appId = null;
  appId ??= state.apps[0]?.id ?? null;
  if (!appId) {
    closeStream();
    Object.assign(state, { view: 'app', appId: null, deployments: [], deploymentId: null, record: null });
    mountEmpty();
    renderAll();
    return;
  }
  if (appId !== state.appId) {
    closeStream();
    Object.assign(state, { view: 'app', appId, deployments: [], deploymentId: null, record: null, cancelling: null });
    mountAppPage();
    renderAll();
    try {
      await loadDeployments();
    } catch (error) {
      toast(error.message, true);
    }
    if (state.appId !== appId) return;
    checkHealth(appId);
  }
  // Keep the address in step with what is shown, so a reload or a bookmark comes back here.
  if (!location.hash.startsWith(`#/apps/${enc(appId)}`)) history.replaceState(null, '', `#/apps/${enc(appId)}`);
  const wanted = deploymentId && state.deployments.some((record) => record.id === deploymentId) ? deploymentId : null;
  state.followLatest = !wanted || wanted === state.deployments[0]?.id;
  showDeployment(wanted ?? state.deployments[0]?.id ?? null);
  renderAll();
}

function route() {
  if (location.hash.startsWith('#/queue')) return selectQueue();
  const match =/^#\/apps\/([^/]+)(?:\/d\/([^/]+))?/.exec(location.hash);
  return selectApp(match ? decodeURIComponent(match[1]) : null, match?.[2] ? decodeURIComponent(match[2]) : null);
}

async function refresh() {
  let data;
  try {
    data = await api('GET', '/api/state');
  } catch {
    state.offline = true;
    renderTopbar();
    return;
  }
  const first = !state.loaded;
  Object.assign(state, { apps: data.apps, meta: data.meta, loaded: true, offline: false });
  if (first) {
    await route();
    return;
  }
  if (state.view === 'queue') {
    await loadQueue();
    renderAll();
    return;
  }
  if ((state.appId && !currentApp()) || (!state.appId && state.apps.length)) {
    await route();
    return;
  }
  const app = currentApp();
  if (app?.last && app.last.id !== state.deployments[0]?.id) {
    // A deploy was started somewhere else, for example from a terminal.
    await loadDeployments().catch(() => {});
    if (state.followLatest) showDeployment(app.last.id);
  } else if (app?.last && !stream) {
    const index = state.deployments.findIndex((record) => record.id === app.last.id);
    if (index !== -1) state.deployments[index] = app.last;
    if (state.record?.id === app.last.id) state.record = app.last;
  }
  if (state.cancelling && !isLive(state.record)) state.cancelling = null;
  renderAll();
}

// ---------- add / edit dialog ----------
const appDialog = $('#app-dialog');
const appForm = $('#app-form');
let editing = null;
let nameTouched = false;
let folderTimer = null;

function setFieldErrors(form, fields = {}) {
  for (const node of form.querySelectorAll('.field-error')) {
    const message = fields[node.dataset.for] ?? '';
    node.textContent = message;
    const input = form.querySelector(`[name="${node.dataset.for}"]`);
    input?.classList.toggle('is-invalid', Boolean(message));
  }
}

function openAppDialog(app = null) {
  editing = app;
  nameTouched = Boolean(app);
  appForm.reset();
  setFieldErrors(appForm);
  $('#app-form-error').textContent = '';
  $('#app-dialog-title').textContent = app ? `Edit ${app.name}` : 'Add an app';
  $('#save-app').textContent = app ? 'Save' : 'Add app';
  $('#delete-app').hidden = !app;
  $('#paste-section').hidden = Boolean(app);
  $('#paste-result').textContent = 'Liftoff fills in the fields below from them.';
  $('#paste-result').className = 'hint';
  $('#f-password').type = 'password';
  $('#f-password').placeholder = app?.hasPassword ? 'Empty keeps the stored one' : '';
  const protection = state.meta?.vault.backend === 'dpapi' ? 'encrypted by Windows for your account' : 'obscured with a key file';
  $('#password-hint').textContent = `Kept on this computer, ${protection}. It is never shown again and never written to a log.`;
  if (app) {
    $('#f-name').value = app.name;
    $('#f-image').value = app.image;
    $('#f-username').value = app.username;
    $('#f-contextDir').value = app.contextDir;
    $('#f-platform').value = app.platform;
    $('#f-dockerfile').value = app.dockerfile ?? '';
    $('#f-buildFlags').value = app.buildFlags ?? '';
    $('#f-liveUrl').value = app.liveUrl ?? '';
  }
  appForm.querySelector('.advanced').open = Boolean(app && (app.dockerfile || app.buildFlags || app.liveUrl || app.platform !== 'linux/amd64'));
  checkFolder();
  appDialog.showModal();
  (app ? $('#f-name') : $('#f-commands')).focus();
}

function applyCommands() {
  const text = $('#f-commands').value;
  const result = $('#paste-result');
  if (!text.trim()) {
    result.textContent = 'Liftoff fills in the fields below from them.';
    result.className = 'hint';
    return;
  }
  const parsed = parseLaunchpadCommands(text);
  if (parsed.image) $('#f-image').value = parsed.image;
  if (parsed.username) $('#f-username').value = parsed.username;
  if (parsed.platform) $('#f-platform').value = parsed.platform;
  if (parsed.dockerfile) $('#f-dockerfile').value = parsed.dockerfile;
  if (parsed.name && !nameTouched) $('#f-name').value = parsed.name;
  const found = ['login', 'build', 'push'].filter((verb) => parsed.recognized.includes(verb));
  if (parsed.warning) {
    result.textContent = parsed.warning;
    result.className = 'hint is-warn';
  } else if (parsed.image && parsed.username) {
    result.textContent = `Read the ${found.join(', ')} command${found.length === 1 ? '' : 's'}. Check the fields below, then add the password and the folder.`;
    result.className = 'hint is-ok';
  } else if (found.length) {
    result.textContent = `Found ${found.join(' and ')}, but ${parsed.username ? 'no image name' : 'no username'} yet. Paste all three commands.`;
    result.className = 'hint is-warn';
  } else {
    result.textContent = 'No docker login, build or push command in that text yet.';
    result.className = 'hint is-warn';
  }
}

async function checkFolder() {
  const dir = $('#f-contextDir').value.trim();
  const hint = $('#folder-result');
  const fallback = 'The folder with the Dockerfile. Copy its path from File Explorer’s address bar.';
  if (!dir) {
    hint.textContent = fallback;
    hint.className = 'hint';
    return;
  }
  try {
    const dockerfile = $('#f-dockerfile').value.trim();
    const answer = await api('POST', '/api/check-folder', { dir, dockerfile });
    if ($('#f-contextDir').value.trim() !== dir) return;
    if (!answer.absolute) [hint.textContent, hint.className] = ['Use the full path, for example D:\\projects\\my-app', 'hint is-warn'];
    else if (!answer.exists) [hint.textContent, hint.className] = ['That folder does not exist on this computer.', 'hint is-warn'];
    else if (!answer.hasDockerfile) [hint.textContent, hint.className] = [`The folder exists, but there is no ${dockerfile || 'Dockerfile'} in it.`, 'hint is-warn'];
    else [hint.textContent, hint.className] = [`${dockerfile || 'Dockerfile'} found.`, 'hint is-ok'];
  } catch {
    hint.textContent = fallback;
    hint.className = 'hint';
  }
}

async function saveApp(event) {
  event.preventDefault();
  setFieldErrors(appForm);
  $('#app-form-error').textContent = '';
  const value = (id) => $(`#${id}`).value.trim();
  let image;
  try {
    image = parseImageRef(value('f-image'));
  } catch (error) {
    setFieldErrors(appForm, { image: error.message });
    $('#f-image').focus();
    return;
  }
  const body = {
    name: value('f-name'),
    ...image,
    username: value('f-username'),
    contextDir: value('f-contextDir'),
    platform: value('f-platform'),
    dockerfile: value('f-dockerfile'),
    buildFlags: value('f-buildFlags'),
    liveUrl: value('f-liveUrl'),
  };
  const password = $('#f-password').value;
  if (password.trim()) body.password = password;
  const button = $('#save-app');
  button.disabled = true;
  try {
    const { app } = editing
      ? await api('PUT', `/api/apps/${enc(editing.id)}`, body)
      : await api('POST', '/api/apps', body);
    appDialog.close();
    delete state.health[app.id];
    await refresh();
    if (location.hash === `#/apps/${enc(app.id)}`) await route();
    else location.hash = `#/apps/${enc(app.id)}`;
    if (body.password) runLoginTest(app.id);
    if (app.liveUrl) checkHealth(app.id);
  } catch (error) {
    const fields = { ...error.fields };
    // The form has one image box for what the server checks as three parts.
    fields.image = fields.registry ?? fields.repository ?? fields.tag;
    setFieldErrors(appForm, fields);
    if (!error.fields) $('#app-form-error').textContent = error.message;
    else if (['platform', 'dockerfile', 'buildFlags', 'liveUrl'].some((name) => fields[name])) appForm.querySelector('.advanced').open = true;
    appForm.querySelector('.is-invalid')?.focus();
  } finally {
    button.disabled = false;
  }
}

function confirmAction({ title, text, action }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = action;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

async function deleteApp() {
  const app = editing;
  if (!app) return;
  const sure = await confirmAction({
    title: `Remove ${app.name}?`,
    text: 'This forgets the app, its stored password and its deploy history on this computer. Nothing changes on Launchpad or in the registry.',
    action: 'Remove app',
  });
  if (!sure) return;
  try {
    await api('DELETE', `/api/apps/${enc(app.id)}`);
    appDialog.close();
    history.replaceState(null, '', '#/');
    state.appId = null;
    await refresh();
    await route();
    toast(`${app.name} removed`);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------- password dialog ----------
const passwordDialog = $('#password-dialog');
let passwordApp = null;

function openPasswordDialog(app) {
  passwordApp = app;
  $('#password-form').reset();
  $('#p-password').type = 'password';
  $('#p-username').textContent = app.username;
  const protection = state.meta?.vault.backend === 'dpapi' ? 'encrypted by Windows for your account' : 'obscured with a key file';
  $('#p-hint').textContent = `Kept on this computer, ${protection}. Saving tests it against ${app.registry} right away.`;
  $('#forget-password').hidden = !app.hasPassword;
  setFieldErrors($('#password-form'));
  passwordDialog.showModal();
  $('#p-password').focus();
}

async function savePassword(event) {
  event.preventDefault();
  const app = passwordApp;
  const form = $('#password-form');
  try {
    await api('PUT', `/api/apps/${enc(app.id)}/password`, { password: $('#p-password').value });
    passwordDialog.close();
    form.reset();
    await refresh();
    runLoginTest(app.id);
  } catch (error) {
    form.querySelector('.field-error').textContent = error.fields?.password ?? error.message;
  }
}

async function forgetPassword() {
  const app = passwordApp;
  const sure = await confirmAction({
    title: 'Forget the password?',
    text: `Liftoff will not be able to deploy ${app.name} until you enter it again.`,
    action: 'Forget password',
  });
  if (!sure) return;
  try {
    await api('DELETE', `/api/apps/${enc(app.id)}/password`);
    passwordDialog.close();
    delete state.login[app.id];
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------- wiring ----------
$('#add-app').addEventListener('click', () => openAppDialog());
appForm.addEventListener('submit', saveApp);
$('#delete-app').addEventListener('click', deleteApp);
$('#f-commands').addEventListener('input', applyCommands);
$('#f-name').addEventListener('input', () => { nameTouched = true; });
for (const id of ['f-contextDir', 'f-dockerfile']) {
  $(`#${id}`).addEventListener('input', () => {
    clearTimeout(folderTimer);
    folderTimer = setTimeout(checkFolder, 300);
  });
}
$('#password-form').addEventListener('submit', savePassword);
$('#forget-password').addEventListener('click', forgetPassword);

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
for (const button of document.querySelectorAll('[data-reveal]')) {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.reveal);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    button.textContent = hidden ? 'Hide' : 'Show';
  });
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    // Nothing typed into a password box outlives its dialog.
    for (const input of dialog.querySelectorAll('#f-password, #p-password')) {
      input.value = '';
      input.type = 'password';
    }
    for (const button of dialog.querySelectorAll('[data-reveal]')) button.textContent = 'Show';
  });
}

window.addEventListener('hashchange', route);
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
function tickClocks() {
  for (const node of document.querySelectorAll('[data-since]')) {
    node.textContent = duration(Date.now() - Date.parse(node.dataset.since));
  }
}
setInterval(tickClocks, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
