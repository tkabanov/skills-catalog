// Regression checks for how the recorder scrolls to elements and draws the pointer, on small local pages.
// Run: node tests/scroll-regressions.mjs   (RECORDER=/path/to/recorder.mjs to test another copy)
// Each scenario states the correct behaviour; a FAIL means the recorder gets it wrong.
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const recorderPath = resolve(process.env.RECORDER ?? new URL('../scripts/recorder.mjs', import.meta.url).pathname);
const { runScenarios, expect } = await import(pathToFileURL(recorderPath).href);

const items = (n, style) => Array.from({ length: n }, (_, i) => `<div class="it" id="i${i}" style="${style}">item ${i}</div>`).join('');
const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}${head}</style></head><body>${body}</body></html>`;

const PAGES = {
  // 1: body counted as a scroller when its overflow is propagated to the viewport
  '/body-overflow': page(`<div style="height:2000px"></div><button id="t">target</button><div style="height:1000px"></div>`, 'html,body{height:100%} body{overflow-x:hidden}'),
  // 2: the target itself is position:fixed, low enough to fall into the caption zone
  '/fixed-target': page(`<div style="height:3000px"></div><button id="t" style="position:fixed;right:20px;bottom:20px;height:40px">fab</button>`),
  // 3: a carousel that scrolls by script, overflow-x:hidden
  '/hidden-carousel': page(`<div id="c" style="margin:1500px 0 1500px 100px;width:400px;overflow-x:hidden;display:flex">${items(6, 'flex:0 0 300px;height:80px;background:#ddd;border:1px solid #999;box-sizing:border-box')}</div>`),
  // 3b: a page locked under a modal (overflow:hidden on the root), target below the fold
  '/locked': page(`<div style="height:2000px"></div><button id="t">target</button><div style="height:1000px"></div>`, 'html{overflow:hidden}'),
  // 5: a scroller whose border is part of its bounding box but not of its visible content area
  '/thick-border': page(`<div style="height:500px"></div><div id="s" style="height:50px;overflow-y:auto;border-bottom:140px solid #333;width:300px">${items(10, 'height:50px;background:#9cf;box-sizing:border-box;border:1px solid #036')}</div><div style="height:2000px"></div>`),
  // 6: right-to-left horizontal scroller
  '/rtl': `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="s" style="margin:1500px 0;width:400px;overflow-x:auto;display:flex">${items(6, 'flex:0 0 300px;height:80px;background:#ddd;border:1px solid #999;box-sizing:border-box')}</div></body></html>`,
  // 7: slotted content scrolled inside a closed shadow root
  '/closed-shadow': page(`<div style="height:300px"></div><x-panel>${items(20, 'height:50px;background:#cfc;border:1px solid #393;box-sizing:border-box')}</x-panel><div style="height:3000px"></div>
<script>customElements.define('x-panel', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<div style="height:150px;overflow:auto;width:300px"><slot></slot></div>'; } });</script>`),
  // 8: <details> also fires toggle events; the recorder should not react with popover toggles of its own
  '/details': page(`<button id="t" style="margin:20px">hover me</button><details id="d"><summary>FAQ</summary>answer</details>
<script>window.recorderToggles = 0; for (const type of ['toggle', 'beforetoggle']) addEventListener(type, (e) => { if (e.target instanceof Element && (e.target.hasAttribute('data-pw-recorder') || e.target.localName === 'x-pw-glass')) window.recorderToggles += 1; }, true);</script>`),
};

const server = createServer((req, res) => {
  const html = PAGES[req.url];
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
  res.end(html ?? 'not found');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const baseURL = `http://127.0.0.1:${server.address().port}`;

/** is the element's whole box inside its scroller's content (client) area */
const insideClientArea = (p, target, scroller) => p.evaluate(([t, s]) => {
  const el = document.querySelector(t), sc = document.querySelector(s), b = el.getBoundingClientRect(), r = sc.getBoundingClientRect();
  const top = r.top + sc.clientTop, left = r.left + sc.clientLeft;
  return b.top >= top - 1 && b.bottom <= top + sc.clientHeight + 1 && b.left >= left - 1 && b.right <= left + sc.clientWidth + 1;
}, [target, scroller]);

const scenarios = [
  {
    id: 'R1', title: 'body{overflow-x:hidden} does not stop the page scroll', expected: 'The target ends up in the viewport',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/body-overflow'));
      const t = p.locator('#t');
      await step('Scroll to the target', () => t.scrollIntoViewIfNeeded());
      await check('Target is in the viewport', () => expect(t).toBeInViewport({ timeout: 500 }));
    },
  },
  {
    id: 'R2', title: 'A position:fixed target does not scroll the page', expected: 'scrollY stays 0',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/fixed-target'));
      await step('Hover the fixed button', () => p.locator('#t').hover());
      await check('Page did not scroll', async () => expect(await p.evaluate(() => scrollY)).toBe(0));
    },
  },
  {
    id: 'R3', title: 'scrollIntoViewIfNeeded brings an item of an overflow-x:hidden carousel into view', expected: 'The last item is in the viewport',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/hidden-carousel'));
      const t = p.locator('#i5');
      await step('Scroll to the last item', () => t.scrollIntoViewIfNeeded());
      await check('Item is in the viewport', () => expect(t).toBeInViewport({ timeout: 500 }));
    },
  },
  {
    id: 'R3b', title: 'scrollIntoViewIfNeeded reaches a target on a page locked with overflow:hidden', expected: 'The target is in the viewport',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/locked'));
      const t = p.locator('#t');
      await step('Scroll to the target', () => t.scrollIntoViewIfNeeded());
      await check('Target is in the viewport', () => expect(t).toBeInViewport({ timeout: 500 }));
    },
  },
  {
    id: 'R5', title: 'An item is scrolled into the content area, not under the scroller border', expected: 'The item is inside the client area',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/thick-border'));
      await step('Scroll to item 3', () => p.locator('#i3').scrollIntoViewIfNeeded());
      await check('Item 3 is inside the content area', async () => expect(await insideClientArea(p, '#i3', '#s')).toBe(true));
    },
  },
  {
    id: 'R6', title: 'An RTL horizontal scroller is scrolled to the item', expected: 'The last item is visible',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/rtl'));
      await step('Scroll to the last item', () => p.locator('#i5').scrollIntoViewIfNeeded());
      await check('Item is inside the scroller and on screen', async () => {
        expect(await insideClientArea(p, '#i5', '#s')).toBe(true);
        await expect(p.locator('#i5')).toBeInViewport({ timeout: 500 });
      });
    },
  },
  {
    id: 'R7', title: 'Slotted content inside a closed shadow root scroller is scrolled into view', expected: 'Item 15 is visible',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/closed-shadow'));
      const t = p.locator('#i15');
      await step('Scroll to item 15', () => t.scrollIntoViewIfNeeded());
      await check('Item is visible (not clipped by the panel)', () => expect(t).toBeInViewport({ ratio: 0.9, timeout: 500 }));
    },
  },
  {
    id: 'R8', title: 'Opening a <details> does not toggle the recorder popovers', expected: 'No toggle events from the recorder elements',
    run: async ({ page: p, step, check }) => {
      await step('Open', () => p.goto('/details'));
      await step('Hover, which draws the pointer', () => p.locator('#t').hover());
      await step('Open the details from script', async () => {
        await p.evaluate(() => { window.recorderToggles = 0; document.querySelector('#d').open = true; });
        await p.waitForTimeout(200);
      });
      await check('No recorder toggle events', async () => expect(await p.evaluate(() => window.recorderToggles)).toBe(0));
    },
  },
];

try {
  const results = await runScenarios({ outDir: process.env.OUT_DIR ?? join(tmpdir(), 'recorder-regressions'), title: 'Recorder: scrolling and pointer', environment: 'local test pages', baseURL, scenarios });
  console.log('\nSUMMARY');
  for (const r of results) console.log(`${r.status === 'passed' ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}`);
} finally {
  server.close();
}
