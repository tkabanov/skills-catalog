// An API pane: a small request client drawn in the browser, so an API scenario records like a UI one.
// The page only shows: Node holds the real request, sends it with the pane's APIRequestContext when Send is clicked,
// and hands the page a copy with secrets masked. Real tokens never reach the DOM, the video or the trace's snapshots.
// Masking walks the values themselves, never a serialized string: a replace in JSON text misses escaped secrets
// and can break the JSON (a masked number becomes a bare ***).

const ORIGIN = 'http://api-client.localhost';
const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|session|otp|jwt|signature|private|credential/i;
const BODY_TYPE_LIMIT = 300; // longer bodies are pasted: typing them would take the whole scenario
const RENDER_LINE_LIMIT = 1500;
const TEXT_LIMIT = 20000;
const STRING_LIMIT = 500; // one value of a JSON shown on screen
const ITEMS_LIMIT = 300; // items of one array or keys of one object shown on screen
const DEPTH_LIMIT = 30;

/** A header value or a JSON field shown as *** when its name looks secret; `Bearer abc` keeps its scheme */
function maskValue(value) {
  const text = String(value);
  const scheme = text.match(/^(Bearer|Basic|Token|Digest)\s+/i);
  return scheme ? `${scheme[0]}***` : '***';
}

/** Every scalar inside a value, for the scrub: a secret field may hold an object or a list */
function leaves(value, found) {
  if (value && typeof value === 'object') Object.values(value).forEach((item) => leaves(item, found));
  else if (value !== null && value !== undefined) found.push(String(value));
}

/** A field whose name looks secret shows as ***, whole, whatever it holds; its values go to `found` for the scrub */
function maskJson(value, reveal, found) {
  if (Array.isArray(value)) return value.map((item) => maskJson(item, reveal, found));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY.test(key) && !reveal.has(key) && item !== null && item !== undefined) {
        leaves(item, found);
        return [key, typeof item === 'object' ? '***' : maskValue(item)];
      }
      return [key, maskJson(item, reveal, found)];
    }));
  }
  return value;
}

/** What goes to the page: every string scrubbed as it is, and the size bounded, so a huge answer can't hang the pane */
function forScreen(value, scrub, depth = 0) {
  if (typeof value === 'string') {
    const text = scrub(value);
    return text.length > STRING_LIMIT ? `${text.slice(0, STRING_LIMIT)}… (${text.length} chars)` : text;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= DEPTH_LIMIT) return '…';
  if (Array.isArray(value)) {
    const shown = value.slice(0, ITEMS_LIMIT).map((item) => forScreen(item, scrub, depth + 1));
    if (value.length > ITEMS_LIMIT) shown.push(`… ${value.length - ITEMS_LIMIT} more items`);
    return shown;
  }
  const entries = Object.entries(value);
  const shown = Object.fromEntries(entries.slice(0, ITEMS_LIMIT).map(([key, item]) => [scrub(key), forScreen(item, scrub, depth + 1)]));
  if (entries.length > ITEMS_LIMIT) shown['…'] = `${entries.length - ITEMS_LIMIT} more keys`;
  return shown;
}

/** A body given as a string is still masked when it is JSON or a form, as an object body would be */
function rawBodyShown(text, contentType, reveal, found) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return { kind: 'json', text: JSON.stringify(maskJson(parsed, reveal, found), null, 2) };
  } catch {
    // not JSON
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(text.trim())) {
    const masked = maskJson(Object.fromEntries(new URLSearchParams(text.trim())), reveal, found);
    return { kind: 'form', text: Object.entries(masked).map(([k, v]) => `${k}=${v}`).join('\n') };
  }
  return { kind: 'raw', text };
}

function maskHeaders(entries, reveal, found) {
  return entries.map(([name, value]) => {
    if (!SECRET_KEY.test(name) || reveal.has(name.toLowerCase())) return [name, value];
    found.push(String(value).replace(/^(Bearer|Basic|Token|Digest)\s+/i, ''));
    return [name, maskValue(value)];
  });
}

function maskQuery(url, reveal, found) {
  try {
    const parsed = new URL(url);
    for (const [name, value] of [...parsed.searchParams]) {
      if (SECRET_KEY.test(name) && !reveal.has(name)) {
        found.push(value);
        parsed.searchParams.set(name, '***');
      }
    }
    return decodeURI(parsed.toString());
  } catch {
    return url;
  }
}

function resolveUrl(url, params, baseURL) {
  const full = new URL(url, baseURL ?? undefined);
  for (const [name, value] of Object.entries(params ?? {})) full.searchParams.append(name, String(value));
  return full.toString();
}

const sizeText = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/**
 * Opens the client in the pane and returns what a scenario uses: send() and locators on the page for checks.
 * `track` reports each request to the run: for the report, the 5xx count and the browser frame.
 */
export async function openApiConsole({ page, context, request: client, label, baseURL, scrub, addSecret, track }) {
  const jobs = new Map();
  let counter = 0;
  let queue = Promise.resolve(); // one request at a time: the client on screen shows one

  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: consoleHtml(label) }));
  await context.exposeBinding('__apiSend', async (_source, id) => {
    const request = jobs.get(id);
    if (!request || request.sent) return { kind: 'error', error: 'No request to send' };
    request.sent = true;
    const started = Date.now();
    try {
      const response = await client.fetch(request.url, { method: request.method, headers: request.headers, data: request.data, form: request.form, failOnStatusCode: false, timeout: request.timeout });
      const timeMs = Date.now() - started;
      const buffer = await response.body();
      const headers = response.headersArray().map(({ name, value }) => [name, value]);
      const text = buffer.toString('utf8');
      let json;
      const looksJson = /json/i.test(response.headers()['content-type'] ?? '') || /^\s*[[{]/.test(text);
      if (looksJson) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      request.result = { status: response.status(), statusText: response.statusText(), headers: response.headers(), headersArray: headers, text, json, timeMs, size: buffer.length };
      // first collect this response's secrets, then scrub: what the page gets has none of them, wherever they repeat
      const found = [];
      const headersMasked = maskHeaders(headers, request.reveal, found);
      const jsonMasked = json !== undefined ? maskJson(json, request.reveal, found) : undefined;
      found.forEach(addSecret);
      return {
        kind: json !== undefined ? 'json' : text ? 'text' : 'empty',
        status: response.status(),
        statusText: scrub(response.statusText()),
        timeMs,
        size: sizeText(buffer.length),
        headers: forScreen(headersMasked, scrub),
        json: jsonMasked !== undefined ? forScreen(jsonMasked, scrub) : undefined,
        text: json === undefined ? scrub(text.slice(0, TEXT_LIMIT)) + (text.length > TEXT_LIMIT ? '\n… truncated' : '') : undefined,
      };
    } catch (error) {
      request.error = String(error.message ?? error).split('\n')[0];
      return { kind: 'error', error: scrub(request.error), timeMs: Date.now() - started };
    }
  });
  await page.goto(`${ORIGIN}/`);

  const ui = {
    /** The status of the last response, e.g. "201 Created" */
    status: page.locator('#res-status'),
    time: page.locator('#res-time'),
    /** The whole response body */
    body: page.locator('#res-body'),
    /** A field of the JSON response by its path: 'id', 'items[0].price', 'user.email'. An object or array covers its whole block */
    field: (path) => page.locator(`#res-body [data-path=${JSON.stringify(path)}]`),
    /** A response header row, by name. It is on screen once the Headers tab is open: await ui.showHeaders() first */
    header: (name) => page.locator(`#res-headers [data-header=${JSON.stringify(name.toLowerCase())}]`),
    /** Opens the response's Headers tab, with a click the video shows */
    showHeaders: () => page.locator('#res-tabs [data-tab="headers"]').click(),
    /** Back to the response body */
    showBody: () => page.locator('#res-tabs [data-tab="body"]').click(),
    url: page.locator('#url'),
    sendButton: page.locator('#send'),
  };

  /**
   * Fills the client as a person would, clicks Send, waits for the response on screen and returns it.
   * request: { method = 'GET', url, params?, headers?, body? (object → JSON, string → raw), form? }
   * opts: { reveal: ['sessionId'] to show a field whose name only looks secret, type: false to paste instead of typing, timeout }
   */
  function send(request, opts = {}) {
    const run = queue.then(() => sendNow(request, opts));
    queue = run.catch(() => {});
    return run;
  }

  async function sendNow(request, opts) {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = resolveUrl(request.url, request.params, baseURL);
    const headers = { ...(request.headers ?? {}) };
    let data, form, bodyShown = '', bodyKind = 'none';
    if (request.form) {
      form = request.form;
      bodyKind = 'form';
    } else if (request.body !== undefined) {
      data = request.body;
      bodyKind = typeof request.body === 'string' ? 'raw' : 'json';
      if (bodyKind === 'json' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const reveal = new Set([...(opts.reveal ?? [])].flatMap((name) => [name, name.toLowerCase()]));
    const found = [];
    if (bodyKind === 'json') bodyShown = JSON.stringify(maskJson(data, reveal, found), null, 2);
    if (bodyKind === 'raw') {
      const contentType = Object.entries(headers).find(([h]) => h.toLowerCase() === 'content-type')?.[1] ?? '';
      bodyShown = rawBodyShown(data, contentType, reveal, found).text;
    }
    if (bodyKind === 'form') bodyShown = Object.entries(maskJson(form, reveal, found)).map(([k, v]) => `${k}=${v}`).join('\n');
    const headersMasked = maskHeaders(Object.entries(headers), reveal, found);
    const urlMasked = maskQuery(url, reveal, found);
    const params = [...new URL(url).searchParams].map(([k, v]) => [k, SECRET_KEY.test(k) && !reveal.has(k) ? '***' : v]);
    found.forEach(addSecret);
    const urlShown = scrub(urlMasked);

    counter += 1;
    const job = { id: counter, method, url, headers, data, form, reveal, timeout: opts.timeout ?? 30000 };
    jobs.set(job.id, job);
    const typing = opts.type !== false;
    const bodyText = scrub(bodyShown);
    const shown = { method, url: urlShown, headers: forScreen(headersMasked, scrub), params: forScreen(params, scrub), body: bodyText.length > TEXT_LIMIT ? `${bodyText.slice(0, TEXT_LIMIT)}\n… truncated` : bodyText, bodyKind };
    const pasteBody = !typing || shown.body.length > BODY_TYPE_LIMIT;
    // the page takes Node's id, so a reload of the client between requests can't put the two out of step
    await page.evaluate(({ shown, pasteBody, id }) => window.__console.prepare(shown, pasteBody, id), { shown, pasteBody, id: job.id });

    await page.locator('#method').selectOption(method);
    // the API's address is already there, as a saved base URL would be: only the path is typed
    const origin = baseURL && shown.url.startsWith(new URL(baseURL).origin) ? new URL(baseURL).origin : '';
    // focused here with the caret at the end: Playwright's own focus leaves it at the start
    await page.evaluate((value) => { const url = document.querySelector('#url'); url.value = value; url.focus(); url.setSelectionRange(value.length, value.length); }, typing ? origin : shown.url);
    if (typing) await ui.url.pressSequentially(shown.url.slice(origin.length));
    if (shown.body && !pasteBody) await page.locator('#body').fill(shown.body);
    await ui.sendButton.click();
    try {
      await page.locator(`#response[data-done="${job.id}"]`).waitFor({ timeout: job.timeout + 5000 });
    } finally {
      jobs.delete(job.id);
    }

    const done = job;
    const path = urlShown.replace(/^[a-z]+:\/\/[^/]+/i, '') || '/';
    if (done.error) {
      track({ method, url: urlShown, path, error: done.error });
      throw new Error(`${method} ${urlShown}: ${done.error}`);
    }
    const r = done.result;
    track({ method, url: urlShown, path, status: r.status, statusText: r.statusText, timeMs: r.timeMs });
    // a bounding box of an element in a scroll box: let the browser settle the new response before checks look at it
    await ui.status.waitFor();
    return {
      method,
      url,
      status: r.status,
      statusText: r.statusText,
      ok: r.status >= 200 && r.status < 300,
      headers: r.headers,
      headersArray: r.headersArray,
      timeMs: r.timeMs,
      text: r.text,
      /** The parsed JSON body; throws when the body is not JSON */
      json: () => {
        if (r.json === undefined) throw new Error(`${method} ${path} did not answer with JSON: ${scrub(r.text.slice(0, 200))}`);
        return r.json;
      },
    };
  }

  return { send, ui };
}

/** The page itself. Everything shown is set with textContent: the response comes from the app under test */
function consoleHtml(label) {
  const title = JSON.stringify(/\bapi\b/i.test(label) ? label : `${label} · API`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6eb;--text:#1f2329;--dim:#6b7280;--accent:#ea580c;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
aside{width:230px;flex:none;border-right:1px solid var(--line);background:#fbfbfc;display:flex;flex-direction:column}
aside h2{margin:0;padding:14px 16px 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
#history{list-style:none;margin:0;padding:0 8px;overflow:auto}
#history li{display:flex;gap:8px;align-items:center;padding:7px 8px;border-radius:6px;font-size:13px}
#history li.current{background:#eef1f5}
#history .p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px}
#history .s{font-family:var(--mono);font-size:12px;font-weight:600}
#history .empty{color:var(--dim);font-size:13px;padding:4px 8px}
main{flex:1;min-width:0;display:flex;flex-direction:column;padding:16px 18px;gap:14px}
.bar{display:flex;gap:8px}
.bar .field{flex:1;display:flex;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}
#method{appearance:none;border:0;border-right:1px solid var(--line);padding:0 14px;font:700 13px var(--mono);background:#fafafa;cursor:pointer}
#url{flex:1;min-width:0;border:0;padding:11px 12px;font:14px var(--mono);outline:none;background:transparent;color:var(--text)}
#send{border:0;border-radius:8px;padding:0 26px;background:#2563eb;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
#send:disabled{background:#93a7d8}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);align-items:center}
.tabs button{border:0;background:none;padding:10px 12px;font:inherit;font-size:13px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer}
.tabs button.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.tabs .count{color:var(--dim);font-weight:400}
.tabs .meta{margin-left:auto;display:flex;gap:14px;font-size:13px;color:var(--dim)}
.meta b{font-weight:600}
#req{flex:0 0 auto;max-height:36%}
#req .view{padding:10px 14px;overflow:auto}
table.kv{border-collapse:collapse;width:100%;font:13px var(--mono)}
table.kv td{border-bottom:1px solid #f0f1f4;padding:6px 8px;vertical-align:top;word-break:break-all}
table.kv td:first-child{width:34%;color:#374151}
#body{width:100%;min-height:90px;resize:none;border:1px solid var(--line);border-radius:6px;padding:10px;font:13px/1.5 var(--mono);color:var(--text);outline:none}
.none{color:var(--dim);font-size:13px;padding:4px 0}
#response{flex:1}
#response .view{flex:1;overflow:auto;padding:8px 0}
.idle{margin:auto;color:var(--dim);text-align:center;padding:40px}
.spin{width:22px;height:22px;border:3px solid #dbe3f3;border-top-color:#2563eb;border-radius:50%;animation:r .8s linear infinite;margin:0 auto 10px}
@keyframes r{to{transform:rotate(360deg)}}
#res-status{padding:2px 10px;border-radius:6px;font-weight:700;font-family:var(--mono);font-size:13px}
.ok{background:#dcfce7;color:#166534}.redirect{background:#e0e7ff;color:#3730a3}.warn{background:#fef3c7;color:#92400e}.bad{background:#fee2e2;color:#991b1b}
#res-body{font:13px/1.6 var(--mono);counter-reset:line}
.ln{display:flex;white-space:pre-wrap;word-break:break-all}
.ln::before{counter-increment:line;content:counter(line);flex:none;width:44px;padding-right:12px;text-align:right;color:#b0b6bf;user-select:none}
.node{border-radius:4px}
.k{color:#9333ea}.str{color:#15803d}.num{color:#c2410c}.bool{color:#2563eb}.nul{color:#6b7280}.pn{color:#6b7280}
pre.text{margin:0;padding:4px 16px;font:13px/1.6 var(--mono);white-space:pre-wrap;word-break:break-all}
.err{margin:16px;padding:12px 14px;border-radius:8px;background:#fee2e2;color:#991b1b;font-weight:600}
${'.m-GET{color:#15803d}.m-POST{color:#b45309}.m-PUT{color:#1d4ed8}.m-PATCH{color:#7c3aed}.m-DELETE{color:#b91c1c}.m-HEAD,.m-OPTIONS{color:#6b7280}'}
@media (max-width:900px){aside{display:none}main{padding:10px;gap:10px}#send{padding:0 14px}}
</style></head><body>
<aside><h2>History</h2><ul id="history"><li class="empty">No requests yet</li></ul></aside>
<main>
  <div class="bar"><div class="field"><select id="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => `<option class="m-${m}">${m}</option>`).join('')}</select><input id="url" placeholder="Enter request URL" spellcheck="false" autocomplete="off"></div><button id="send">Send</button></div>
  <section class="card" id="req"><div class="tabs" id="req-tabs"><button data-tab="params">Params</button><button data-tab="headers">Headers</button><button data-tab="body">Body</button></div><div class="view" id="req-view"></div></section>
  <section class="card" id="response"><div class="tabs" id="res-tabs"><button data-tab="body" class="on">Response</button><button data-tab="headers">Headers</button><div class="meta" id="res-meta"></div></div><div class="view" id="res-view"><div class="idle">Send a request to see the response</div></div></section>
</main>
<script>
document.title = ${title};
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const state = { req: null, reqTab: 'params', res: null, resTab: 'body', history: [] };
const tone = (s) => s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'redirect' : 'ok';
const bodyBox = el('textarea'); bodyBox.id = 'body'; bodyBox.spellcheck = false;

function methodColor() { const m = $('#method'); m.className = 'm-' + m.value; }
$('#method').addEventListener('change', methodColor); methodColor();

function kvTable(rows, attr) {
  if (!rows.length) return el('div', 'none', 'None');
  const t = el('table', 'kv');
  for (const [k, v] of rows) { const tr = el('tr'); if (attr) tr.dataset[attr] = k.toLowerCase(); tr.append(el('td', '', k), el('td', '', v)); t.append(tr); }
  return t;
}

function renderReq() {
  const r = state.req || { params: [], headers: [], bodyKind: 'none' };
  for (const b of document.querySelectorAll('#req-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === state.reqTab);
    const n = b.dataset.tab === 'params' ? r.params.length : b.dataset.tab === 'headers' ? r.headers.length : 0;
    b.replaceChildren(b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)); if (n) b.append(el('span', 'count', ' (' + n + ')'));
  }
  const view = $('#req-view');
  if (state.reqTab === 'params') view.replaceChildren(kvTable(r.params));
  else if (state.reqTab === 'headers') view.replaceChildren(kvTable(r.headers));
  else view.replaceChildren(r.bodyKind === 'none' ? el('div', 'none', 'This request has no body') : bodyBox);
}
for (const b of document.querySelectorAll('#req-tabs button')) b.addEventListener('click', () => { state.reqTab = b.dataset.tab; renderReq(); });

function jsonNode(value, path, key, last, depth) {
  const wrap = el('div', 'node'); wrap.dataset.path = path;
  const line = (parts, d) => { const ln = el('div', 'ln'); const code = el('span'); code.style.paddingLeft = (16 + d * 18) + 'px'; for (const p of parts) code.append(p); ln.append(code); return ln; };
  const head = key === null ? [] : [el('span', 'k', JSON.stringify(key)), el('span', 'pn', ': ')];
  const comma = last ? [] : [el('span', 'pn', ',')];
  if (value && typeof value === 'object') {
    const arr = Array.isArray(value), entries = arr ? value.map((v, i) => [i, v]) : Object.entries(value);
    if (!entries.length) { wrap.append(line([...head, el('span', 'pn', arr ? '[]' : '{}'), ...comma], depth)); return wrap; }
    wrap.append(line([...head, el('span', 'pn', arr ? '[' : '{')], depth));
    entries.forEach(([k, v], i) => {
      if (state.lines++ > ${RENDER_LINE_LIMIT}) return;
      const childPath = arr ? path + '[' + k + ']' : (path ? path + '.' + k : String(k));
      wrap.append(jsonNode(v, childPath, arr ? null : k, i === entries.length - 1, depth + 1));
    });
    wrap.append(line([el('span', 'pn', arr ? ']' : '}'), ...comma], depth));
    return wrap;
  }
  const cls = typeof value === 'string' ? 'str' : typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'nul';
  wrap.append(line([...head, el('span', cls, JSON.stringify(value)), ...comma], depth));
  return wrap;
}

function renderRes() {
  const r = state.res, view = $('#res-view'), meta = $('#res-meta');
  for (const b of document.querySelectorAll('#res-tabs button')) b.classList.toggle('on', b.dataset.tab === state.resTab);
  meta.replaceChildren();
  if (!r) { view.replaceChildren(Object.assign(el('div', 'idle'), { textContent: 'Send a request to see the response' })); return; }
  if (r.loading) { const d = el('div', 'idle'); d.append(el('div', 'spin'), el('div', '', 'Sending request…')); view.replaceChildren(d); return; }
  if (r.kind === 'error') { view.replaceChildren(el('div', 'err', 'Could not send request: ' + r.error)); return; }
  const status = el('span', tone(r.status), r.status + ' ' + (r.statusText || '')); status.id = 'res-status';
  const time = el('span'); time.id = 'res-time'; time.append('Time ', el('b', '', r.timeMs + ' ms'));
  const size = el('span'); size.append('Size ', el('b', '', r.size));
  meta.append(status, time, size);
  if (state.resTab === 'headers') { const box = el('div'); box.id = 'res-headers'; box.style.padding = '2px 14px'; box.append(kvTable(r.headers, 'header')); view.replaceChildren(box); return; }
  const body = el('div'); body.id = 'res-body';
  if (r.kind === 'json') { state.lines = 0; body.append(jsonNode(r.json, '', null, true, 0)); if (state.lines > ${RENDER_LINE_LIMIT}) body.append(el('div', 'none', '      … the rest is not shown')); }
  else if (r.kind === 'text') body.append(el('pre', 'text', r.text));
  else body.append(el('div', 'idle', 'Empty response body'));
  view.replaceChildren(body); view.scrollTop = 0;
}
for (const b of document.querySelectorAll('#res-tabs button')) b.addEventListener('click', () => { state.resTab = b.dataset.tab; renderRes(); });

function renderHistory() {
  const list = $('#history');
  if (!state.history.length) return;
  list.replaceChildren(...state.history.map((h, i) => {
    const li = el('li', i === state.history.length - 1 ? 'current' : '');
    li.append(el('span', 'm-' + h.method, h.method), el('span', 'p', h.path));
    if (h.status) li.append(el('span', 's ' + tone(h.status), String(h.status)));
    return li;
  }).reverse());
}

let sendId = 0;
window.__console = {
  prepare(shown, pasteBody, id) {
    state.req = shown; state.res = null; state.resTab = 'body';
    state.reqTab = shown.bodyKind !== 'none' ? 'body' : shown.headers.length ? 'headers' : 'params';
    $('#url').value = ''; bodyBox.value = pasteBody ? shown.body : '';
    sendId = id; $('#send').disabled = false;
    renderReq(); renderRes();
  },
};

$('#send').addEventListener('click', async () => {
  const id = sendId, r = state.req; if (!r) return;
  $('#send').disabled = true; state.res = { loading: true }; renderRes();
  const entry = { method: r.method, path: r.url.replace(/^[a-z]+:\\/\\/[^/]+/i, '') || '/' };
  state.history.push(entry); renderHistory();
  const res = await window.__apiSend(id);
  state.res = res; entry.status = res.status; renderRes(); renderHistory();
  $('#send').disabled = false;
  $('#response').dataset.done = String(id);
});
renderReq();
</script></body></html>`;
}
