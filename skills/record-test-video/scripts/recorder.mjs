// Runs test scenarios in a real browser, records one video per scenario, writes a report.
// Usage: see ../SKILL.md and ../assets/test-template.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chmodSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromeHeight, renderChromeTrack, trackChrome } from './browser-chrome.mjs';
import { chromium, devices, request as apiRequest, expect as playwrightExpect } from 'playwright/test';

export const expect = playwrightExpect;

const VIEWPORT = { width: 1280, height: 800 };
const PHONE = devices['Pixel 7'];
const VIEWPORTS = {
  desktop: { id: 'desktop', label: 'desktop', ...VIEWPORT },
  phone: { id: 'phone', label: 'phone', ...PHONE.viewport, mobile: true },
};
const MOBILE_CONTEXT = { userAgent: PHONE.userAgent, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true };
const NARROW_PX = 600;
const TOTAL_DEADLINE_MS = 10 * 60 * 1000;
const SCENARIO_DEADLINE_MS = 3 * 60 * 1000;
const STEP_TIMEOUT_MS = 15000;
const STEP_LEAD_MS = 1000;
const TYPE_DELAY_MS = 75;
const TYPE_MAX_MS = 2500;
const FIXED_TOP_PX = 90; // a page's sticky header
const CAPTION_PX = 110;
const PANE_GAP = 4;

const expandHome = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const slug = (scenario) => scenario.id.toLowerCase().replace(/[^a-z0-9а-я-]+/gi, '-');

/** 'desktop', 'phone', '1920x1080' or { width, height, id?, label?, mobile? } */
function resolveViewport(spec) {
  if (typeof spec === 'string' && VIEWPORTS[spec]) return VIEWPORTS[spec];
  const size = typeof spec === 'string' ? spec.match(/^(\d+)x(\d+)$/) : null;
  const custom = size ? { width: Number(size[1]), height: Number(size[2]) } : spec;
  if (!custom?.width || !custom?.height) throw new Error(`Unknown viewport: ${JSON.stringify(spec)}. Use desktop, phone, 1920x1080 or { width, height }`);
  return { id: `${custom.width}x${custom.height}`, label: `${custom.width}×${custom.height}`, ...custom };
}

/** One scenario per viewport. Only a scenario that is desktop alone keeps its id without a suffix */
function expandViewports(options) {
  return options.scenarios.flatMap((scenario) => {
    const viewports = [scenario.viewports ?? options.viewports ?? ['desktop']].flat().map(resolveViewport);
    return viewports.map((viewport) => (viewports.length === 1 && viewport.id === 'desktop'
      ? { ...scenario, baseId: scenario.id, viewport }
      : { ...scenario, baseId: scenario.id, id: `${scenario.id}-${viewport.id}`, title: `${scenario.title} (${viewport.label})`, viewport }));
  });
}

/** The caption along the bottom of the video: what is being done now, in the reader's words */
const caption = (text, tone, narrow, atTop) => {
  const background = { step: '#1f2937', ok: '#047857', fail: '#b91c1c' }[tone];
  const fit = narrow ? 'width:max-content;max-width:92%;padding:8px 14px;font:600 16px/1.3 system-ui,sans-serif' : 'max-width:84%;padding:12px 22px;font:600 20px/1.35 system-ui,sans-serif';
  return `<div style="position:fixed;left:50%;${atTop ? 'top' : 'bottom'}:${narrow ? 16 : 28}px;${fit};transform:translateX(-50%);border-radius:12px;background:${background};color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:2147483647">${escapeHtml(text)}</div>`;
};

/** Shows a caption until the returned function is called. Not with the duration option: that one blocks until the caption is gone */
async function showCaption(page, text, tone, atTop = false) {
  const narrow = (page.viewportSize()?.width ?? VIEWPORT.width) < NARROW_PX;
  // a caption must never fail the test: the page may be navigating
  const overlay = await page.screencast.showOverlay(caption(text, tone, narrow, atTop)).catch(() => null);
  return () => overlay?.dispose().catch(() => {});
}

/** An element at the very end of a page can't scroll clear of the caption, so there the caption goes to the top. Only for the look */
async function underCaption(page, target) {
  if (!target) return false;
  const box = await [target].flat()[0].boundingBox({ timeout: 1000 }).catch(() => null);
  return Boolean(box) && box.y + box.height > (page.viewportSize()?.height ?? VIEWPORT.height) - CAPTION_PX;
}

/**
 * Draws the pointer, which a headless browser doesn't, and marks clicks. Runs in the page. Not screencast.showActions:
 * it always draws the action's title, which quotes typed values ('Fill "<password>"'), and fontSize: 0 does not hide it.
 * On a touch screen the pointer is a fingertip: a round mark, centred on the point.
 */
const drawPointer = ({ touch }) => {
  const NS = 'http://www.w3.org/2000/svg';
  let pointer = null;
  addEventListener('mousemove', ({ clientX, clientY }) => {
    if (!pointer && touch) {
      pointer = document.createElement('div');
      pointer.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;box-sizing:border-box;border-radius:50%;background:rgba(17,24,39,.3);border:2px solid #fff;pointer-events:none;z-index:2147483646;box-shadow:0 1px 3px rgba(0,0,0,.45)';
      document.documentElement.append(pointer);
    } else if (!pointer) {
      pointer = document.createElementNS(NS, 'svg');
      pointer.setAttribute('viewBox', '0 0 20 24');
      pointer.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:24px;pointer-events:none;z-index:2147483646;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))';
      const arrow = document.createElementNS(NS, 'path');
      arrow.setAttribute('d', 'M2 1 L2 19 L7 14.5 L10.5 22 L13.5 20.6 L10 13.2 L16.5 13 Z');
      arrow.setAttribute('fill', '#111827');
      arrow.setAttribute('stroke', '#fff');
      arrow.setAttribute('stroke-width', '1.5');
      pointer.append(arrow);
      document.documentElement.append(pointer);
    }
    pointer.style.transform = touch ? `translate(${clientX - 13}px, ${clientY - 13}px)` : `translate(${clientX - 2}px, ${clientY - 1}px)`;
  }, true);
  addEventListener('pointerdown', ({ clientX, clientY }) => {
    const mark = document.createElement('div');
    mark.style.cssText = `position:fixed;left:${clientX - 16}px;top:${clientY - 16}px;width:32px;height:32px;box-sizing:border-box;border-radius:50%;background:rgba(37,99,235,.35);border:2px solid rgba(37,99,235,.9);pointer-events:none;z-index:2147483645`;
    document.documentElement.append(mark);
    setTimeout(() => mark.remove(), 700);
  }, true);
};

// ── moving like a person: a scenario's ordinary click() and fill() look unhurried in the video ──

const humanPages = new WeakSet();
const pointers = new WeakMap();
let humanized = false;

/** Eased, slightly curved, and the farther the longer */
async function movePointer(page, x, y) {
  const size = page.viewportSize() ?? VIEWPORT;
  const from = pointers.get(page) ?? { x: size.width / 2, y: size.height / 2 };
  const dx = x - from.x, dy = y - from.y, distance = Math.hypot(dx, dy);
  const duration = Math.min(700, Math.max(180, distance * 1.1)), steps = Math.max(6, Math.round(duration / 16));
  const bend = distance * 0.07 * (Math.random() < 0.5 ? -1 : 1);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps, eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2, arc = i === steps ? 0 : Math.sin(Math.PI * t) * bend;
    await page.mouse.move(from.x + dx * eased - (dy / (distance || 1)) * arc, from.y + dy * eased + (dx / (distance || 1)) * arc);
    await sleep(duration / steps);
  }
  pointers.set(page, { x, y });
}

/** A smooth scroll, and only when needed; the element ends clear of a sticky header and of the caption */
async function scrollSmoothly(locator) {
  const height = locator.page().viewportSize()?.height ?? VIEWPORT.height;
  let box = await locator.boundingBox({ timeout: 1000 });
  if (!box || (box.y >= FIXED_TOP_PX && box.y + box.height <= height - CAPTION_PX)) return;
  await locator.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  for (let i = 0, last = null; i < 25; i += 1) {
    await sleep(80);
    box = await locator.boundingBox({ timeout: 1000 });
    if (box?.y === last) break;
    last = box?.y;
  }
}

/** Only for the look: a failure here must not fail a test, the action itself decides */
async function approach(locator, position) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 3000 });
    await scrollSmoothly(locator);
    const box = await locator.boundingBox({ timeout: 1000 });
    if (!box) return;
    await movePointer(locator.page(), box.x + (position?.x ?? box.width / 2), box.y + (position?.y ?? box.height / 2));
    await sleep(120);
  } catch {
    // the page may be navigating, or the element is one a label stands in for
  }
}

async function typeLikeAPerson(page, text, delayMs) {
  const chars = Array.from(text), base = Math.min(delayMs, TYPE_MAX_MS / chars.length);
  for (const char of chars) {
    await page.keyboard.type(char);
    await sleep(base * (0.6 + Math.random() * 0.8) + (char === ' ' ? base : 0));
  }
}

/** Once per run: every Locator and Page share these prototypes. A page outside humanPages behaves as Playwright's does */
function humanize(page, typeDelayMs) {
  if (humanized) return;
  humanized = true;
  const L = Object.getPrototypeOf(page.locator('body')), P = Object.getPrototypeOf(page);
  const { click, fill, pressSequentially } = L;

  for (const name of ['click', 'dblclick', 'tap', 'hover', 'check', 'uncheck', 'selectOption', 'setChecked']) {
    const original = L[name];
    L[name] = async function (...args) {
      if (humanPages.has(this.page())) await approach(this, ['selectOption', 'setChecked'].includes(name) ? undefined : args[0]?.position);
      return original.apply(this, args);
    };
  }

  L.fill = async function (value, options) {
    const page = this.page();
    if (!humanPages.has(page) || !value) return fill.call(this, value, options);
    const typable = await this.evaluate((node) => node.isContentEditable || ((node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && ['text', 'password', 'email', 'tel', 'search', 'url', 'number'].includes(node.type))) && !node.readOnly && !node.disabled), undefined, options).catch(() => false);
    if (!typable) return fill.call(this, value, options);
    await approach(this);
    try {
      await click.call(this, { timeout: 3000 });
      await this.focus({ timeout: 1000 });
    } catch {
      return fill.call(this, value, options); // something covers it: Playwright's fill doesn't need a click
    }
    if (await this.inputValue({ timeout: 500 }).catch(() => '')) await fill.call(this, '', options);
    await typeLikeAPerson(page, value, typeDelayMs);
    return undefined;
  };

  L.pressSequentially = async function (text, options) {
    if (!humanPages.has(this.page())) return pressSequentially.call(this, text, options);
    await approach(this);
    return pressSequentially.call(this, text, { delay: typeDelayMs, ...options });
  };

  const { scrollIntoViewIfNeeded } = L;
  L.scrollIntoViewIfNeeded = async function (options) {
    if (!humanPages.has(this.page())) return scrollIntoViewIfNeeded.call(this, options);
    await this.waitFor({ state: 'attached', timeout: options?.timeout });
    return scrollSmoothly(this);
  };

  // page.fill(selector, ...) and the like go past the Locator, so they are sent through it
  for (const name of ['click', 'dblclick', 'tap', 'hover', 'fill', 'check', 'uncheck']) {
    const original = P[name];
    P[name] = function (selector, ...args) {
      return humanPages.has(this) ? this.locator(selector)[name](...args) : original.call(this, selector, ...args);
    };
  }
}

const EVEN_SIZE = 'pad=ceil(iw/2)*2:ceil(ih/2)*2'; // yuv420p takes no odd sizes, and a phone's or a custom viewport can have them

function videoLengthMs(video) {
  const run = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const seconds = Number.parseFloat(run.stdout ?? '');
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function grabFrame(video, atMs, file) {
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(atMs / 1000), '-i', video, '-frames:v', '1', file]);
}

/**
 * Draws over the page, around what matters: the rest dims, a stroke runs around each element, an optional note beside it.
 * Only for the look: a failure here must not fail a test. Returns what removes it, or null when there is nothing to mark.
 */
async function drawMark(page, target, tone, note) {
  try {
    const locators = Array.isArray(target) ? target : [target];
    await locators[0].scrollIntoViewIfNeeded({ timeout: 1000 });
    const boxes = (await Promise.all(locators.map((l) => l.boundingBox({ timeout: 1000 }).catch(() => null)))).filter(Boolean);
    if (!boxes.length) return null;
    const { width, height } = page.viewportSize() ?? VIEWPORT, color = tone === 'fail' ? '#ef4444' : '#f59e0b', pad = boxes.length > 1 ? 2 : 6, r = 10;
    const areas = boxes.map((b) => ({ x: Math.max(2, b.x - pad), y: Math.max(2, b.y - pad), w: Math.min(b.width + pad * 2, width - 4), h: Math.min(b.height + pad * 2, height - 4) }));
    const hole = ({ x, y, w, h }) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
    const dim = `<div style="position:fixed;left:0;top:0;width:${width}px;height:${height}px;background:rgba(15,23,42,.42);clip-path:path(evenodd,'M0 0H${width}V${height}H0Z${areas.map(hole).join('')}');animation:pw-mark-dim .25s ease-out"></div>`;
    // Plain blocks, not SVG: the overlay's reset styles wipe an SVG's geometry. Without the animation (a strict page CSP) the mark just stands still.
    const rings = areas.map(({ x, y, w, h }) => `<div style="position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;border:4px solid ${color};border-radius:${r}px;box-shadow:0 0 0 2px rgba(255,255,255,.85),0 0 18px ${color};animation:pw-mark-ring .45s ease-out"></div>`).join('');
    const first = areas[0], above = first.y >= 60;
    // over the far end of a wide row, where the row above it usually has nothing to hide
    const side = first.w > 500 ? `right:${Math.max(4, width - first.x - first.w)}px` : `left:${Math.max(4, Math.min(first.x, width - 420))}px`;
    const label = note ? `<div style="position:fixed;${side};${above ? `top:${first.y - 44}px` : `top:${first.y + first.h + 10}px`};max-width:${Math.min(400, width - 8)}px;padding:6px 12px;border-radius:8px;background:${color};color:#111827;font:600 15px/1.3 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)">${escapeHtml(note)}</div>` : '';
    const motion = '<style>@keyframes pw-mark-dim{from{opacity:0}}@keyframes pw-mark-ring{from{opacity:0;transform:scale(1.25)}}</style>';
    const overlay = await page.screencast.showOverlay(`${motion}${dim}${rings}${label}`);
    return () => overlay.dispose().catch(() => {});
  } catch {
    return null;
  }
}

/** With several panes: a frame around the one being acted in, and its name in the corner when no browser frame carries it */
function paneBadge(pane, active) {
  const color = active ? '#2563eb' : '#475569';
  return `${active ? `<div style="position:fixed;inset:0;border:3px solid ${color};box-sizing:border-box"></div>` : ''}${pane.chrome ? '' : `<div style="position:fixed;left:10px;bottom:10px;padding:4px 12px;border-radius:7px;background:${color};color:#fff;font:600 15px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)">${escapeHtml(pane.label)}</div>`}`;
}

async function openPane(browser, definition, options, result, multi, shared) {
  const label = definition.label ?? definition.id;
  const { viewport } = definition;
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ...(viewport.mobile ? MOBILE_CONTEXT : {}), baseURL: definition.baseURL ?? options.baseURL, locale: 'en-GB', timezoneId: options.timezoneId, ...options.contextOptions, ...definition.contextOptions });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  await context.addInitScript(drawPointer, { touch: Boolean(viewport.mobile) });
  const page = await context.newPage();
  if (options.human !== false) {
    humanize(page, options.typeDelayMs ?? TYPE_DELAY_MS);
    humanPages.add(page);
    // a new document has no pointer until the mouse moves
    page.on('load', () => { const at = pointers.get(page); if (at) page.mouse.move(at.x, at.y).catch(() => {}); });
  }
  const chrome = options.browserChrome === false ? null : trackChrome(page, shared);
  const tag = multi ? `[${label}] ` : '';
  page.on('pageerror', (error) => {
    result.consoleErrors.push(`${tag}pageerror: ${error.message}`.slice(0, 300));
    chrome?.countConsoleError();
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // "Failed to load resource" says nothing without the address, which is in the location
    result.consoleErrors.push(`${tag}${message.text()} ${message.location().url ?? ''}`.trim().slice(0, 300));
    chrome?.countConsoleError();
  });
  page.on('response', (response) => {
    if (response.status() < 500) return;
    result.failedRequests.push(`${tag}${response.status()} ${response.request().method()} ${response.url()}`.slice(0, 300));
    chrome?.countServerError();
  });
  return { id: definition.id, label, context, page, viewport, chrome };
}

/**
 * One video of the panes side by side, on one clock, each under its browser frame. Each pane is aligned by when its first
 * frame really came; a pane that gave no frame falls back to what its length says beyond the time measured.
 * When the frame can't be drawn the video goes without it, and when ffmpeg fails the first pane's webm stays.
 */
async function composeVideos(browser, panes, mp4, chromeDir, frameInfo) {
  for (const pane of panes) {
    if (pane.firstFrameAt) continue;
    const length = videoLengthMs(pane.webm) ?? pane.stoppedAt - pane.startedAt;
    pane.firstFrameAt = pane.startedAt - Math.max(0, length - (pane.stoppedAt - pane.startedAt));
  }
  const earliest = Math.min(...panes.map((pane) => pane.firstFrameAt));
  const lengthMs = Math.max(...panes.map((pane) => pane.stoppedAt)) - earliest;

  let lists = null;
  if (panes.every((pane) => pane.chrome)) {
    try {
      lists = [];
      for (const pane of panes) {
        lists.push(await renderChromeTrack({ browser, chrome: pane.chrome, viewport: pane.viewport, dir: join(chromeDir, pane.id), zero: earliest, lengthMs, label: panes.length > 1 ? pane.label : '', ...frameInfo }));
      }
    } catch (error) {
      console.error(`record-test-video: browser frame not drawn, the video goes without it: ${String(error.message ?? error).split('\n')[0]}`);
      lists = null;
    }
  }

  const encode = (withFrame) => {
    const n = panes.length, frameHeight = (pane) => (withFrame ? chromeHeight(pane.viewport) : 0);
    const height = Math.max(...panes.map((pane) => pane.viewport.height + frameHeight(pane))); // hstack takes one height: a shorter pane gets a dark strip below
    const inputs = [...panes.flatMap((pane) => ['-i', pane.webm]), ...(withFrame ? lists.flatMap((list) => ['-f', 'concat', '-safe', '0', '-i', list]) : [])];
    const chains = panes.map((pane, i) => {
      const video = `[${i}:v]tpad=start_duration=${((pane.firstFrameAt - earliest) / 1000).toFixed(3)}:start_mode=clone`;
      const framed = withFrame ? `${video},format=yuv420p[p${i}];[${n + i}:v]format=yuv420p[c${i}];[c${i}][p${i}]vstack=shortest=1` : video;
      return `${framed},pad=iw+${i < n - 1 ? PANE_GAP : 0}:${height}:0:0:color=0x111827[v${i}]`;
    });
    const joined = n > 1 ? `${panes.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${n}:shortest=1,${EVEN_SIZE}[out]` : `[v0]${EVEN_SIZE}[out]`;
    const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    if (run.status !== 0 && withFrame) console.error(`record-test-video: ffmpeg could not add the browser frame, the video goes without it: ${(run.stderr ?? '').trim().split('\n').at(-1)}`);
    return run.status === 0 && existsSync(mp4);
  };
  const done = (lists && encode(true)) || encode(false);
  rmSync(chromeDir, { recursive: true, force: true });
  if (!done) return { video: panes[0].webm, earliest };
  for (const pane of panes) rmSync(pane.webm);
  return { video: mp4, earliest };
}

async function runScenario(browser, scenario, options, dirs, root) {
  const name = slug(scenario);
  const result = { id: scenario.id, title: scenario.title, expected: scenario.expected, status: 'passed', recordedAt: new Date().toISOString(), environment: options.environment ?? null, commits: options.commits ?? null, steps: [], error: null, consoleErrors: [], failedRequests: [], video: null, trace: null, traces: [] };

  for (const file of readdirSync(dirs.frames)) {
    if (file.startsWith(`${name}-`)) rmSync(join(dirs.frames, file));
  }
  rmSync(join(dirs.failures, `${name}.png`), { force: true });

  // a pane's own viewport wins over the scenario's: an admin panel stays on a desktop beside a site on a phone
  const definitions = (scenario.panes ?? [{ id: 'main' }]).map((definition) => ({ ...definition, viewport: resolveViewport(definition.viewport ?? scenario.viewport ?? 'desktop') })), multi = definitions.length > 1;
  const panes = [];
  const shared = { passed: 0, failed: 0 }; // what every pane's browser frame shows alike
  for (const definition of definitions) panes.push(await openPane(browser, definition, options, result, multi, shared));
  const countInFrames = (key) => {
    shared[key] += 1;
    for (const pane of panes) pane.chrome?.push();
  };

  // the video first: tracing's own screenshots capture at 800x800 and would shrink the shared frames if they started first
  for (const pane of panes) {
    pane.webm = join(dirs.video, `${name}${multi ? `-${pane.id}` : ''}.webm`);
    // the size of the viewport, not larger: a larger one doesn't scale the page, it leaves the rest of the frame grey
    // the first frame's own time is the video's zero: an estimate from the file's length came out up to a second early
    await pane.page.screencast.start({ path: pane.webm, size: { width: pane.viewport.width, height: pane.viewport.height }, onFrame: () => { pane.firstFrameAt ??= Date.now(); } });
    pane.startedAt = Date.now();
  }
  const startedAt = panes[0].startedAt;
  for (const pane of panes) await pane.context.tracing.start({ screenshots: true, snapshots: true });

  let active = null;
  const activate = async (pane) => {
    if (!multi || active === pane) return;
    active = pane;
    for (const other of panes) other.chrome?.update({ active: other === pane });
    await Promise.all(panes.map(async (other) => {
      await other.hideBadge?.();
      const overlay = await other.page.screencast.showOverlay(paneBadge(other, other === pane)).catch(() => null);
      other.hideBadge = () => overlay?.dispose().catch(() => {});
    }));
  };

  const record = async (pane, kind, text, action, opts = {}) => {
    const entry = { kind, text, status: 'passed', at: Date.now() - startedAt };
    if (multi) entry.pane = pane.label;
    result.steps.push(entry);
    if (result.status === 'failed') {
      entry.status = 'skipped';
      return undefined;
    }
    await activate(pane);
    const page = pane.page;
    let hide = kind === 'step' ? await showCaption(page, text, 'step') : null, unmark = null;
    try {
      if (kind === 'step') await sleep(STEP_LEAD_MS); // the viewer reads what is about to happen, then sees it
      const value = await action();
      await pane.chrome?.sync();
      await hide?.();
      if (kind === 'check') {
        countInFrames('passed');
        // first the mark, then the caption: the dimming must not lie over the caption
        if (opts.highlight) unmark = await drawMark(page, opts.highlight, 'ok', opts.note);
        hide = await showCaption(page, `✓ ${text}`, 'ok', await underCaption(page, opts.highlight));
        entry.shownAt = Date.now() - startedAt;
        await sleep(options.checkPauseMs ?? 2400);
        await hide();
        await unmark?.();
      } else {
        await sleep(options.stepPauseMs ?? 500);
      }
      entry.endedAt = Date.now() - startedAt;
      return value;
    } catch (error) {
      await hide?.();
      await pane.chrome?.sync();
      countInFrames('failed');
      entry.status = 'failed';
      result.status = 'failed';
      result.error = String(error.message ?? error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1200);
      await page.screenshot({ path: join(dirs.failures, `${name}.png`) }).catch(() => {});
      if (kind === 'check' && opts.highlight) unmark = await drawMark(page, opts.highlight, 'fail', opts.note);
      const hideFailure = await showCaption(page, `✗ ${text}`, 'fail', kind === 'check' && await underCaption(page, opts.highlight));
      entry.shownAt = Date.now() - startedAt;
      await sleep(3000);
      await hideFailure();
      await unmark?.();
      entry.endedAt = Date.now() - startedAt;
      return undefined;
    }
  };

  const paneApi = (pane) => ({
    page: pane.page,
    context: pane.context,
    request: pane.context.request,
    /** An action of the scenario, shown as a caption */
    step: (text, action) => record(pane, 'step', text, action),
    /**
     * An expected result, shown with ✓ when it holds. A failed one fails the scenario, and the video shows it.
     * `highlight`: a locator or several, drawn around once the check has passed (in red when it failed); `note`: a line beside it.
     */
    check: (text, action, opts) => record(pane, 'check', text, action, opts),
    /** Draws attention to something without checking it, so never call a result proven by it */
    highlight: async (target, note, ms = 2200) => {
      if (result.status === 'failed') return;
      await activate(pane);
      const entry = { kind: 'mark', text: note ?? 'Note this', status: 'passed', at: Date.now() - startedAt };
      if (multi) entry.pane = pane.label;
      result.steps.push(entry);
      const unmark = await drawMark(pane.page, target, 'ok', note);
      entry.shownAt = Date.now() - startedAt;
      await sleep(ms);
      await unmark?.();
      entry.endedAt = Date.now() - startedAt;
    },
  });
  const api = {
    ...paneApi(panes[0]),
    creds: options.creds ?? {},
    /** What this run records on: { id, label, width, height, mobile }, for what a phone shows differently */
    viewport: panes[0].viewport,
    /** Every pane by its id, each with its own page, context, request, step, check and highlight */
    panes: Object.fromEntries(panes.map((pane) => [pane.id, paneApi(pane)])),
    /** A pause for reading what is on screen */
    pause: (ms = 1500) => sleep(ms),
  };

  await Promise.all(panes.map((pane) => pane.page.screencast.showChapter(`${scenario.id}. ${scenario.title}`, { description: scenario.expected, duration: 2600 }).catch(() => {})));
  let crashedAt = null;
  try {
    await scenario.run(api);
  } catch (error) {
    result.status = 'failed';
    result.error ??= String(error.message ?? error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1200);
    crashedAt = Date.now() - startedAt;
  }
  // without checks the video proves nothing, whatever it shows
  if (result.status === 'passed' && !result.steps.some((s) => s.kind === 'check')) {
    result.status = 'failed';
    result.error = 'The scenario has no checks (check)';
  }

  const passed = result.status === 'passed';
  await Promise.all(panes.map((pane) => pane.page.screencast.showChapter(passed ? 'Scenario passed' : 'Scenario FAILED', { description: passed ? scenario.title : result.error?.split('\n')[0], duration: 2200 }).catch(() => {})));

  await Promise.all(panes.map(async (pane) => {
    pane.stoppedAt = Date.now();
    await pane.page.screencast.stop();
  }));
  for (const pane of panes) {
    const trace = join(dirs.traces, `${name}${multi ? `-${pane.id}` : ''}.zip`);
    await pane.context.tracing.stop({ path: trace });
    await pane.context.close();
    result.traces.push(relative(root, trace));
  }
  result.trace = result.traces[0];

  // the first frame comes before the clock starts: shift the times so they point at the right place in the video
  const composed = await composeVideos(browser, panes, join(dirs.video, `${name}.mp4`), join(dirs.video, `.frame-${name}`), { scenarioId: scenario.id, environment: options.environment, scrub: options.scrub ?? ((text) => text) });
  const video = composed.video, shift = startedAt - composed.earliest;
  result.video = relative(root, video);
  for (const entry of result.steps) {
    for (const key of ['at', 'shownAt', 'endedAt']) {
      if (entry[key] !== undefined) entry[key] += shift;
    }
  }

  // key frames to look at before saying it works: a recording nobody watched proves little
  for (const [index, entry] of result.steps.filter((s) => s.kind !== 'step' && s.status === 'passed' && s.shownAt).entries()) {
    grabFrame(video, entry.shownAt + 700, join(dirs.frames, `${name}-${String(index + 1).padStart(2, '0')}.png`));
  }
  const failedAt = result.steps.find((s) => s.status === 'failed')?.shownAt ?? (crashedAt === null ? null : crashedAt + shift);
  if (failedAt !== null) grabFrame(video, failedAt + 700, join(dirs.frames, `${name}-failure.png`));

  // what a failure quotes (a typed value, a request) goes into a report people read
  return options.scrub ? JSON.parse(options.scrub(JSON.stringify(result))) : result;
}

// ── the credentials registry: <project folder>/credentials.env, one per project, never in a repository ──

function readRegistry(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** What the test declares against what the registry holds. Adds an empty line, with its description, for each one it has never seen. */
function checkCredentials(options, root) {
  const file = resolve(expandHome(options.credentialsFile ?? join(root, '..', 'credentials.env')));
  const declared = options.credentials ?? {};
  const registry = readRegistry(file);
  const unseen = Object.keys(declared).filter((name) => !(name in registry));
  if (unseen.length) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, unseen.map((name) => `\n# ${String(declared[name]).replace(/\n/g, ' ')}\n${name}=\n`).join(''));
  }
  if (existsSync(file)) chmodSync(file, 0o600);
  const creds = Object.fromEntries(Object.keys(declared).map((name) => [name, process.env[name] || registry[name] || '']));
  return { file, creds, missing: Object.keys(declared).filter((name) => !creds[name]) };
}

/** A failed preflight says the run can't prove anything yet, so nothing is recorded and the last results stay */
async function preflight(options, creds, scrub) {
  if (!options.preflight) return true;
  const request = await apiRequest.newContext({ baseURL: options.baseURL });
  try {
    await options.preflight({ creds, request, expect: playwrightExpect });
    return true;
  } catch (error) {
    console.error(`record-test-video: preflight failed, nothing recorded:\n${scrub(String(error.message ?? error)).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 800)}`);
    return false;
  } finally {
    await request.dispose();
  }
}

/** The report covers every scenario of the test: what this run did not record stays as it was, with its own date and versions */
function report(options, results, root) {
  const mark = { passed: '✅', failed: '❌', skipped: '⏭' };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: options.timezoneId }) : '—');
  const recorded = results.filter((r) => r.status !== 'skipped');
  const failed = results.filter((r) => r.status === 'failed').length;
  const missing = results.length - recorded.length;
  const versions = [...new Set(recorded.map((r) => r.commits))];
  const total = [
    failed ? `❌ failed ${failed} of ${results.length}` : null,
    missing ? `⏭ not recorded ${missing} of ${results.length}` : null,
    !failed && !missing ? `✅ passed ${results.length} of ${results.length}` : null,
  ].filter(Boolean).join(', ');
  const lines = [
    `# ${options.title}: results`,
    '',
    options.environment ? `Environment: ${options.environment}` : null,
    versions.length > 1 ? 'Versions: scenarios were recorded on different versions, see the table' : versions[0] ? `Versions: ${versions[0]}` : null,
    `Total: ${total}`,
    '',
    '| Scenario | Result | Recorded | Video |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.id}. ${r.title} | ${mark[r.status]} | ${when(r.recordedAt)}${versions.length > 1 && r.commits ? `, ${r.commits}` : ''} | ${r.video ? `[${r.video}](../${r.video})` : '—'} |`),
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.id}. ${r.title}`, '', `Expected: ${r.expected}`, '');
    if (r.status === 'skipped') {
      lines.push('Not recorded yet.', '');
      continue;
    }
    lines.push('| Time | Step | Result |', '|---|---|---|');
    for (const s of r.steps) lines.push(`| ${clock(s.at)} | ${s.pane ? `[${s.pane}] ` : ''}${{ check: 'Check: ', mark: 'Showing: ' }[s.kind] ?? ''}${s.text} | ${mark[s.status]} |`);
    lines.push('');
    if (r.error) lines.push('Error:', '', '```', r.error, '```', '');
    if (r.consoleErrors.length) lines.push(`Browser console errors (${r.consoleErrors.length}):`, '', ...[...new Set(r.consoleErrors)].slice(0, 12).map((e) => `- \`${e.replace(/\s+/g, ' ').replace(/`/g, "'")}\``), '');
    if (r.failedRequests.length) lines.push(`Server 5xx responses (${r.failedRequests.length}):`, '', ...[...new Set(r.failedRequests)].slice(0, 12).map((e) => `- \`${e}\``), '');
  }
  writeFileSync(join(root, 'results', 'report.md'), `${lines.filter((l) => l !== null).join('\n')}\n`);
  writeFileSync(join(root, 'results', 'results.json'), `${JSON.stringify({ title: options.title, results }, null, 2)}\n`);
}

function previousResults(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'results', 'results.json'), 'utf8')).results;
  } catch {
    return [];
  }
}

/**
 * @param options.outDir     the task's folder, e.g. ~/test-videos/<project>/<task>
 * @param options.title      the task, for the report
 * @param options.baseURL    optional, for page.goto('/path')
 * @param options.timezoneId optional, the browser's and the report's time zone; the system's by default
 * @param options.human      optional, false: no pointer movement, typing or smooth scrolling, actions at Playwright's speed
 * @param options.typeDelayMs optional, the pause between typed characters
 * @param options.browserChrome optional, false: no browser frame (tab, address, clock, checks, errors) above the page
 * @param options.credentials optional { NAME: 'what it is, for whom, where' }, from the registry or the environment; scenarios get them as creds
 * @param options.credentialsFile optional, default <outDir>/../credentials.env
 * @param options.preflight  optional async ({ creds, request, expect }): throws when the credentials or the stand won't do
 * @param options.only       optional scenario ids (or env ONLY=S1,S2), to re-record part of them; S1 takes all its viewports, S1-phone one
 * @param options.viewports  optional, for every scenario: 'desktop' (the default), 'phone', '1920x1080', { width, height, id?, label?, mobile? } or a list of them
 * @param options.scenarios  [{ id, title, expected, viewports?, panes?, run({ page, context, request, step, check, highlight, panes, pause, viewport }) }];
 *                           panes: [{ id, label, baseURL?, viewport? }], recorded side by side, each with its own browser session
 */
export async function runScenarios(options) {
  const root = resolve(expandHome(options.outDir));
  if (!isAbsolute(root)) throw new Error('outDir must resolve to an absolute path');
  const dirs = { video: join(root, 'video'), results: join(root, 'results'), traces: join(root, 'results', 'traces'), failures: join(root, 'results', 'failures'), frames: join(root, 'results', 'frames') };
  for (const dir of [dirs.video, dirs.traces, dirs.frames, dirs.failures]) mkdirSync(dir, { recursive: true });

  options = { ...options, scenarios: expandViewports(options) };
  const only = (options.only ?? process.env.ONLY?.split(',') ?? []).map((id) => id.trim()).filter(Boolean);
  const scenarios = only.length ? options.scenarios.filter((s) => only.includes(s.id) || only.includes(s.baseId)) : options.scenarios;
  if (!scenarios.length) throw new Error(`No scenarios to run, ONLY=${only.join(',')}`);

  const { file, creds, missing } = checkCredentials(options, root);
  if (missing.length) {
    console.error(`record-test-video: credentials missing, nothing recorded. Fill in ${file}:\n${missing.map((name) => `  ${name}: ${options.credentials[name]}`).join('\n')}`);
    process.exitCode = 3;
    return [];
  }
  const secrets = Object.values(creds).filter((value) => value.length >= 4);
  const scrub = (text) => secrets.reduce((out, secret) => out.split(secret).join('***'), text);
  if (!(await preflight(options, creds, scrub))) {
    process.exitCode = 3;
    return [];
  }
  options = { ...options, creds, scrub };

  const known = new Map(previousResults(root).map((r) => [r.id, r]));
  const allResults = () => options.scenarios.map((s) => known.get(s.id) ?? { id: s.id, title: s.title, expected: s.expected, status: 'skipped', steps: [], consoleErrors: [], failedRequests: [], video: null, trace: null });
  const deadline = setTimeout(() => {
    console.error('record-test-video: the whole run took too long, stopping');
    process.exit(2);
  }, options.deadlineMs ?? Math.max(TOTAL_DEADLINE_MS, scenarios.length * SCENARIO_DEADLINE_MS));

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const results = [];
  try {
    for (const scenario of scenarios) {
      const result = await runScenario(browser, scenario, options, dirs, root);
      results.push(result);
      known.set(result.id, result);
      // after each scenario, so that an interrupted run leaves a true report
      report(options, allResults(), root);
      console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${scenario.id} ${scenario.title}`);
      if (result.error) console.log(`  ${result.error.split('\n')[0]}`);
    }
  } finally {
    await browser.close();
    clearTimeout(deadline);
  }

  const failed = results.filter((r) => r.status !== 'passed').length;
  console.log(`\n${results.length - failed}/${results.length} passed. Report: ${join(dirs.results, 'report.md')}`);
  process.exitCode = failed ? 1 : 0;
  return results;
}
