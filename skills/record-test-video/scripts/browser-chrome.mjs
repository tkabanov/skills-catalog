// A browser's frame drawn above the recorded page: tab, address bar with the current URL, and what a tester wants in view
// (the report's clock, checks passed, console errors, 5xx). Headless Chromium has no frame of its own, and screencast
// records only the page, so the frame is tracked while the scenario runs and stacked over the video afterwards.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NARROW_PX = 600;
const SECRET_PARAM = /token|key|secret|pass|code|sig|auth|session|jwt|otp/i;

export const chromeHeight = (viewport) => (viewport.width < NARROW_PX ? 64 : 80);

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

/** The address as a person reads it, with the values of token-like parameters hidden: a reset link is a password */
export function displayUrl(raw, scrub = (text) => text) {
  if (!raw || raw === 'about:blank') return '';
  let shown = raw;
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.set(name, '***');
    if (SECRET_PARAM.test(url.hash)) url.hash = '#***';
    shown = url.toString();
    try {
      shown = decodeURI(shown);
    } catch {
      // keep it encoded
    }
  } catch {
    // not a URL Node can parse: show it as it is
  }
  return scrub(shown);
}

/**
 * Follows what the frame shows for one page: address, title, loading, errors. Each change is a point on the timeline.
 * `shared` holds what all panes of a scenario show alike: the checks passed and failed.
 */
export function trackChrome(page, shared) {
  const state = { url: '', title: '', loading: false, consoleErrors: 0, serverErrors: 0, active: false };
  const timeline = [];
  const push = () => timeline.push({ at: Date.now(), ...state, passed: shared.passed, failed: shared.failed });
  const update = (patch) => {
    if (!Object.entries(patch).some(([key, value]) => state[key] !== value)) return;
    Object.assign(state, patch);
    push();
  };
  const main = (frame) => frame === page.mainFrame();
  // during a navigation the context is gone and title() throws: the next event brings it
  const syncTitle = async () => {
    const title = await page.title().catch(() => null);
    if (title !== null) update({ title });
  };

  page.on('request', (request) => {
    if (request.isNavigationRequest() && main(request.frame())) update({ loading: true, url: request.url() });
  });
  page.on('requestfailed', (request) => {
    if (request.isNavigationRequest() && main(request.frame())) update({ loading: false, url: page.url() });
  });
  // also for pushState, which is how a single-page app moves
  page.on('framenavigated', (frame) => {
    if (!main(frame)) return;
    update({ url: frame.url() });
    syncTitle();
  });
  page.on('domcontentloaded', syncTitle);
  page.on('load', () => {
    update({ loading: false });
    syncTitle();
  });
  push();

  return {
    timeline,
    push,
    update,
    countConsoleError: () => update({ consoleErrors: state.consoleErrors + 1 }),
    countServerError: () => update({ serverErrors: state.serverErrors + 1 }),
    /** Around each step: a title set by script and a navigation that never fired load are caught here */
    sync: async () => {
      update({ url: page.url() });
      const ready = await page.evaluate(() => document.readyState).catch(() => null);
      if (ready === 'complete') update({ loading: false });
      await syncTitle();
    },
  };
}

const LOCK = '<svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7.5" rx="1.5" fill="#5f6368"/><path d="M3.3 6V4.3a2.7 2.7 0 0 1 5.4 0V6" fill="none" stroke="#5f6368" stroke-width="1.6"/></svg>';
const INFO = '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#5f6368" stroke-width="1.4"/><rect x="6.3" y="6" width="1.4" height="4.2" fill="#5f6368"/><rect x="6.3" y="3.4" width="1.4" height="1.4" fill="#5f6368"/></svg>';

function security(url) {
  if (!url) return '';
  if (url.startsWith('https://')) return LOCK;
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(url);
  return local ? INFO : '<span class="insecure">⚠ Not secure</span>';
}

function urlHtml(url) {
  if (!url) return '<span class="dim">New tab</span>';
  const parts = url.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i);
  if (!parts) return escapeHtml(url);
  return `<span class="dim">${escapeHtml(parts[1])}</span><b>${escapeHtml(parts[2])}</b><span class="dim">${escapeHtml(parts[3])}</span>`;
}

function chips(v, narrow) {
  const errors = (count, name, tone) => `<span class="chip ${count ? tone : ''}">${name} ${count}</span>`;
  return [
    `<span class="chip time">⏱ ${v.clock}</span>`,
    `<span class="chip ${v.passed ? 'ok' : ''}">✓ ${v.passed}</span>`,
    v.failed ? `<span class="chip bad">✗ ${v.failed}</span>` : '',
    errors(v.consoleErrors, narrow ? 'cons.' : 'console', 'warn'),
    errors(v.serverErrors, '5xx', 'bad'),
  ].join('');
}

function chromeHtml(v, { narrow, width, height, label, scenarioId, environment, viewportLabel }) {
  const css = `*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#dee1e6;color:#202124;font:13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif}
body.active{background:#c9dcfb}
.tabs{height:36px;display:flex;align-items:flex-end;gap:8px;padding:0 10px}
.tab{flex:0 1 280px;min-width:140px;height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#fff;border-radius:9px 9px 0 0}
.tab .t{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fav{flex:none;width:14px;height:14px;border-radius:50%;background:#9aa0a6}
.fav.spin{background:none;border:2px solid #1a73e8;border-right-color:transparent}
.meta{margin-left:auto;align-self:center;display:flex;gap:6px;min-width:0}
.tag{padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.7);color:#3c4043;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
.pane{background:#1a73e8;color:#fff}
.bar{position:relative;height:44px;display:flex;align-items:center;gap:4px;padding:0 10px;background:#fff;border-bottom:1px solid #dadce0}
.nav{flex:none;width:28px;height:28px;display:grid;place-items:center;color:#5f6368;font-size:17px}
.addr{flex:1;min-width:0;height:32px;display:flex;align-items:center;gap:8px;margin:0 6px;padding:0 14px;border-radius:16px;background:#f1f3f4;font-size:14px}
.addr svg{flex:none}
.url{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.url b{font-weight:500;color:#202124}
.dim{color:#5f6368}
.insecure{flex:none;color:#c5221f;font-size:12px;font-weight:600}
.chips{flex:none;display:flex;gap:5px}
.chip{padding:4px 8px;border-radius:6px;background:#f1f3f4;color:#5f6368;font-size:12px;font-weight:600;white-space:nowrap}
.time{font-variant-numeric:tabular-nums;color:#202124}
.ok{background:#e6f4ea;color:#137333}.warn{background:#fef7e0;color:#b06000}.bad{background:#fce8e6;color:#c5221f}
.progress{position:absolute;left:0;bottom:-1px;width:45%;height:3px;background:#1a73e8}
.narrow .bar{height:40px;padding:0 8px}
.narrow .addr{margin:0;height:30px;padding:0 12px;font-size:13px}
.narrow .row{height:24px;display:flex;align-items:center;gap:4px;padding:0 8px;background:#f8f9fa;border-bottom:1px solid #dadce0}
.narrow .chip{padding:2px 5px;font-size:11px}
.narrow .tag{padding:2px 6px;font-size:11px;max-width:120px}
.narrow .chips{margin-left:auto}
.narrow.active .bar,.narrow.active .row{background:#d2e3fc}`;
  const tags = [label ? `<span class="tag pane">${escapeHtml(label)}</span>` : '', `<span class="tag">${escapeHtml(scenarioId)}${narrow ? '' : ` · ${escapeHtml(viewportLabel)}`}</span>`, environment ? `<span class="tag">${escapeHtml(environment)}</span>` : ''].join('');
  const address = `<div class="addr">${security(v.url)}<span class="url">${urlHtml(v.url)}</span></div>`;
  const progress = v.loading ? '<div class="progress"></div>' : '';
  if (narrow) {
    return `<style>${css}</style><body class="narrow${v.active ? ' active' : ''}"><div class="bar">${address}${progress}</div><div class="row">${tags}<div class="chips">${chips(v, true)}</div></div></body>`;
  }
  return `<style>${css}</style><body class="${v.active ? 'active' : ''}"><div class="tabs"><div class="tab"><span class="fav${v.loading ? ' spin' : ''}"></span><span class="t">${escapeHtml(v.title || (v.url ? v.url : 'New tab'))}</span></div><div class="meta">${tags}</div></div><div class="bar"><span class="nav">←</span><span class="nav">→</span><span class="nav">${v.loading ? '✕' : '↻'}</span>${address}<div class="chips">${chips(v, false)}</div>${progress}</div></body>`;
}

/**
 * Renders the frame's timeline into PNGs and an ffconcat list that plays them in step with the video.
 * `zero` is the moment the video's first frame shows, `lengthMs` the video's length. The clock is cut at every
 * second so that it reads the same as the report's "Time".
 */
export async function renderChromeTrack({ browser, chrome, viewport, dir, zero, lengthMs, label, scenarioId, environment, scrub }) {
  const width = viewport.width, height = chromeHeight(viewport), narrow = width < NARROW_PX;
  mkdirSync(dir, { recursive: true });
  const points = chrome.timeline.map((entry) => ({ ...entry, at: Math.max(0, entry.at - zero) })).sort((a, b) => a.at - b.at);
  const cuts = new Set([0]);
  for (let at = 1000; at < lengthMs; at += 1000) cuts.add(at);
  for (const point of points) if (point.at < lengthMs) cuts.add(point.at);
  const times = [...cuts].sort((a, b) => a - b);

  const segments = [];
  let current = 0;
  for (const [i, at] of times.entries()) {
    while (current + 1 < points.length && points[current + 1].at <= at) current += 1;
    const state = points[current];
    const view = { url: displayUrl(state.url, scrub), title: scrub(state.title ?? ''), loading: state.loading, active: state.active, consoleErrors: state.consoleErrors, serverErrors: state.serverErrors, passed: state.passed, failed: state.failed, clock: clock(at) };
    const key = JSON.stringify(view), end = times[i + 1] ?? lengthMs + 2000; // the last one outlasts the video: the stack stops at the shortest
    if (segments.at(-1)?.key === key) segments.at(-1).end = end;
    else segments.push({ key, view, start: at, end });
  }

  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const files = new Map();
  try {
    const layout = { narrow, width, height, label, scenarioId, environment: environment ? scrub(environment) : '', viewportLabel: `${viewport.label ?? viewport.id} ${viewport.width}×${viewport.height}` };
    for (const segment of segments) {
      if (!files.has(segment.key)) {
        const file = join(dir, `${String(files.size).padStart(4, '0')}.png`);
        await page.setContent(chromeHtml(segment.view, layout));
        await page.screenshot({ path: file });
        files.set(segment.key, file);
      }
      segment.file = files.get(segment.key);
    }
  } finally {
    await page.close();
  }

  const quote = (file) => `'${file.replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  for (const segment of segments) lines.push(`file ${quote(segment.file)}`, `duration ${((segment.end - segment.start) / 1000).toFixed(3)}`);
  lines.push(`file ${quote(segments.at(-1).file)}`); // the concat demuxer drops the last duration without it
  const list = join(dir, 'chrome.ffconcat');
  writeFileSync(list, `${lines.join('\n')}\n`);
  return list;
}
