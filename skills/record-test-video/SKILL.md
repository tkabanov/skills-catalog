---
name: record-test-video
description: Record videos of test scenarios in a real browser, with captions and real checks, for UI and for APIs (a request client on screen, side by side with the site when needed), and keep them with the scenario descriptions, the tests and a results report in ~/test-videos/<project>/<task>/. Use it only when the user asks to record, show or prove how something works, wants a demo for a client, a test video, a screencast or video evidence ("record a video", "show how it works", "test video", "demo for the client"). Don't use it on your own after finishing a feature: only on request.
---

# Record test video

A finished feature, UI or API, gets a short video per scenario, so the owner and the client can watch it work instead of taking a written "it works" on trust. The video is evidence only because real checks run while it records: a failed check fails the scenario, and the video shows that.

A video does not replace unit tests or e2e checks, and it is not diffable. Keep scenarios few and meaningful.

## When to skip

No video for refactors or small tweaks with nothing new to show. A backend change is recorded through an API pane (below) when the user asks for a video of it. Say so in your report instead of recording something empty.

## Where to run it

Run it in the current session. Use a subagent only when the user asks for that, for this task or in their instructions; don't switch on your own, whatever the size of the session.

A subagent keeps frames and fixes out of the main context, but its prompt cache lives 5 minutes, against an hour in the main session, so a recording that runs longer makes it write its whole context to the cache again. It knows nothing of this session either, so give it what changed, the stand, what the scenarios must cover and the task folder, and have it return the folder path and the result per scenario. If the session is already long when you start, say in one line that a subagent is an option.

## The folder

```
~/test-videos/<project>/<task>/     e.g. ~/test-videos/sport-infra/TRK-020/
├── scenarios.md                    what is tested and what should happen
├── tests/run.mjs                   the test itself
├── results/
│   ├── report.md                   result per scenario, steps with timestamps, console errors
│   ├── results.json
│   ├── traces/<id>.zip             for debugging: npx playwright show-trace
│   ├── frames/                     key frames to review
│   └── failures/                   screenshot of a failed step
└── video/<id>.mp4                  one per scenario
```

`<project>` is the repository's folder name, `<task>` the task id, or a short slug when there is none. The folder lives outside the repositories on purpose: videos are heavy, and traces hold whatever the browser saw.

## Workflow

### 1. Write `scenarios.md` before running anything

Write the expected behaviour first. Written after the run, it tends to describe whatever happened, and then the video proves nothing.

```markdown
# <TASK-ID>: <what we check>

Environment: local, test database. Versions: api abc1234, web def5678.
Setup: which test data is needed and where it comes from.

## S1. Scenario name
Who: a regular participant.
Steps: 1) ... 2) ...
Expected: a concrete result that can be checked.
```

Write `scenarios.md` in the language of the user and their client; here that is Russian. Everything that shows in the video is in English: scenario titles and expected results (the video opens and closes with them), step and check captions, highlight notes. Include the unhappy paths that matter (sold out, refused, wrong input), not only the happy one. Three to six scenarios of 20-60 seconds each are usually enough.

### 2. Get a safe environment

Prefer a local stack with test data, or a dev environment. Never record on production. Scenarios that write data belong on a throwaway database; on a shared dev environment stop before anything that creates records, unless the user agreed. Check that the app really talks to the intended API, not a default that points elsewhere.

### 3. Check the credentials before the first run

Before anything runs, list every login, password and token the scenarios need, and make sure each one is in the project's registry and really works. A run that stops at a sign-in screen wastes the recording.

The registry is `~/test-videos/<project>/credentials.env`, one per project and shared by its tasks: `NAME=value` lines, each under a comment saying what it is, for which environment and where it came from. It is outside the repositories, mode 600, and never sent anywhere. Prefix names with the environment: `LOCAL_ADMIN_LOGIN`, `DEV_ADMIN_LOGIN`.

1. Declare them in `tests/run.mjs`: `credentials: { NAME: 'what it is, for whom, where' }`, and a `preflight` that signs in with each and checks that the stand answers. Scenarios get the values as `creds`.
2. Take what you can yourself: a test user you create on a local or throwaway database, a test account documented in the project, a gitignored env file of a test environment. Write down in the comment where it came from.
3. Don't use production credentials, a real person's account or the owner's own login, unless the owner says so for this task.
4. Run it. Exit code 3 means nothing was recorded and earlier results are intact: missing names were added to the registry as empty lines, or the preflight failed.
5. If something is still missing, ask once, in one message, listing all of it: the name, what it is for, and the file to put it in. Ask the owner to write it into the file, not into the chat. Then wait. Don't record part of the scenarios, drop a scenario or fake a sign-in to get around it.

The report names the credentials used, never their values.

### 4. Find selectors with the Playwright MCP

Explore the page step by step with `mcp__playwright__*`. Do not try to produce the final video this way: the pauses while you think would end up in the recording. Prefer roles and visible text over CSS classes.

### 5. Write `tests/run.mjs`

Copy `assets/test-template.mjs` from this skill. Each scenario gets:

- `step('What we do', fn)`: an action, shown as a caption.
- `check('What should be there', fn)`: a real assertion with `expect`, shown with ✓. If it fails, the scenario fails and the remaining steps are skipped.
- `pause(ms)`: time to read the screen.
- `highlight(locator, 'note')`: draws attention without proving anything.
- `simulate('No internet connection', faults.offline())`: turns on a failure the test stages and says so on screen until `end()` (see "Show a staged failure as staged" below).
- also `page`, `context`, `request`, `creds`.

**Show the result, don't just assert it.** On the check that proves the scenario's point, pass `{ highlight: locator, note: 'Now' }`, or an array of locators: once the check has passed, the rest of the screen dims and a ring is drawn around the element, red if the check failed. Use it on the few moments that matter. When everything is highlighted, nothing is. A `highlight()` on its own is not evidence, so don't let it stand where a check belongs.

**Show several systems at once.** When a change in one system should appear in another, give the scenario `panes: [{ id: 'admin', label: 'Admin' }, { id: 'site', label: 'Site' }]`. They record side by side in one video on one clock, each with its own browser session, and a frame marks the one being acted in. `run` gets `panes: { admin, site }`, and each has its own `page`, `context`, `request`, `step`, `check` and `highlight`. Open every pane in the first steps, so that no half of the video stays blank, and leave the receiving side on screen while the other changes it. Then the viewer sees cause and effect, not two separate stories. Two panes make a 2564 px wide video: use them where the link between the systems is the point.

**Show an API.** Give a scenario `kind: 'api'`, or a pane `{ id: 'api', label: 'API', kind: 'api', baseURL }`, and it records a request client instead of a site: method, address, Params, Headers and Body tabs, a Send button, then the response with its status, time, size, headers and highlighted JSON, and a history of the scenario's requests on the left. `send(request, opts)` fills it in as a person would (the base address is already there, the path and a short body are typed), clicks Send, waits for the response on screen and returns `{ status, statusText, ok, headers, text, json(), timeMs }`. The request is `{ method = 'GET', url, params?, headers?, body?, form? }`: an object body goes as JSON, `url` is relative to the pane's `baseURL`. Wrap it in a step and check the answer, highlighting what proves it with `ui`: `ui.status`, `ui.time`, `ui.body`, `ui.field('items[0].price')` (an object or array covers its whole block), and `ui.header('location')` after `await ui.showHeaders()`, which opens the response's Headers tab on screen (`ui.showBody()` goes back).

```js
const res = await step('Create an order', () => send({ method: 'POST', url: '/orders', headers: { Authorization: `Bearer ${token}` }, body: { item: 'Racket', qty: 2 } }));
await check('The server answers 201 Created', () => expect(res.status).toBe(201), { highlight: ui.status });
await check('The order is new', () => expect(res.json().status).toBe('new'), { highlight: ui.field('status') });
```

Node sends the request, so there is no CORS, and the page gets only a copy to show. In that copy, headers, query parameters and JSON fields whose names look secret (`Authorization`, `Cookie`, `password`, `token`, `api_key`, `session`...) show as `***`, a whole object or list under such a name included, and so does a body passed as a JSON or form string. A secret the API hands out is scrubbed from then on wherever it shows: on screen, in error captions and in the report. The pane sends through its own request context, outside tracing, so its trace holds the client page but not the requests with their tokens; `request` in the scenario is that same context and shares its cookies with `send`. A field that only looks secret and is the point of the check goes in `opts.reveal: ['sessionId']`. `opts.type: false` pastes instead of typing; a body over 300 characters is always pasted. Requests of one pane go one at a time, even from a `Promise.all`; a huge answer is cut on screen (long strings, long lists), while `res` keeps all of it. Each request is a line of the report with its status and time, a 5xx counts in the bar and the report like a page's, and a request that gets no answer (refused, timed out) fails its step and shows the error on screen. Put an API pane beside a site pane when the point is that a call shows up in the interface. A pure API check with nothing to show a person belongs in the API's tests, not in a video.

**The browser frame.** Each video has a browser bar drawn above the page: the tab with the page title, the address bar with the current URL (a lock for https, "Not secure" for plain http away from localhost), a loading indicator, and chips for a tester: the clock, which reads the same as "Time" in the report, checks passed ✓ and failed ✗, console errors and 5xx so far, the scenario id, the screen and the environment. With several panes each pane has its own bar with the pane's name, and the active pane's bar turns blue. An API pane's bar shows the address of the last request. A phone gets a compact two-line bar. The bar sits above the page, not over it, so it hides nothing, and the video is 80 px taller (64 on a phone). The address is part of the evidence: a check that a page opened is more convincing when the viewer sees which URL it is. Values of query parameters that look secret (`token`, `key`, `code`, `password`, `session`...) show as `***`, and so do the registry's values. A secret anywhere else in the path does show, so look at the bar on the contact sheet. `browserChrome: false` in the run options turns it off.

**Choose the screens.** By default a scenario records on a desktop, 1280x800. Set `viewports` in the run options for all scenarios, or on one scenario: `'phone'`, `['desktop', 'phone']`, `'1920x1080'`, or `{ id: 'tablet', label: 'tablet', width: 768, height: 1024, mobile: true }`. Take what the task or the user names; otherwise judge by who uses this screen, and add the phone where participants work from one. Each screen is its own video and its own line in the report, with the id `S1-phone`, and `ONLY=S1` re-records all of a scenario's screens. A scenario that behaves differently can read `viewport` (`id`, `width`, `mobile`). `'phone'` is Pixel 7 emulated in Chromium, with touch and a mobile user agent: it shows layout and touch, not the quirks of a real device or of Safari, so name that in the report. Use `locator.tap()` where the tap itself is what you test. Panes take their own screen too: `panes: [{ id: 'admin', label: 'Admin', viewport: 'desktop' }, { id: 'site', label: 'Site', viewport: 'phone' }]`.

**Show a staged failure as staged.** To show how the app copes with something that would not happen on its own during the recording (no internet, a server error, a slow network, a dropped request), the test makes the condition up. A viewer must never take that for a real failure of the system, nor the recovery for a fix of one. So every such condition goes through `simulate(label, start)`, never a bare `page.route` or `setOffline` in the middle of a scenario:

```js
const end = await simulate('The server fails to load the start editor (HTTP 500)', faults.respond(/\/start\/\d+\/editor/, { status: 500 }));
await step('Open the organizers', () => page.getByRole('button', { name: 'Organizers' }).click());
await check('An error with "Retry" instead of an empty list', () => expect(retry).toBeVisible(), { highlight: retry });
await end();
await step('The server is back: click Retry', () => retry.click());
```

On screen it shows "⚡ Simulating: …" when it starts, an amber badge "Simulated by the test: …" in the corner for as long as it is on, and "⚡ Simulation ended: …" when `end()` is called. The report gets the same lines, a list of the simulated conditions with their times, and every console error and 5xx caught while one was on is marked `[during simulation: …]`, so nobody files it as a server bug. A simulation still on when the scenario finishes is ended then. Ready-made conditions, all importable with `runScenarios`: `faults.offline()` (no network at all), `faults.respond(url, { status, body })` (the server's answer replaced), `faults.abort(url)` (no answer, a dropped connection), `faults.delay(url, ms)` (a slow endpoint), `faults.throttle({ latencyMs, downloadKbps, uploadKbps })` (a slow network for the whole page, Chromium only). Anything else is a `start({ page, context })` that sets the condition up and returns how to undo it.

- **Name what is simulated and how**, in the viewer's words, in the label: "No internet connection", "The payment provider times out after 30 s", "The server answers 500 to the start editor". Not "route mocked".
- **Write it into `scenarios.md`** as a step of its own: what is simulated, how (which request, which answer), and why it is not reproduced for real. If the scenario stands in for a failure someone reported, say whether it is the same cause or a stand-in ("the client's prod session had expired; here the server answers 500 instead, which the same screen must handle").
- **Show the normal state first, then the failure, then the recovery** once `end()` has run, so the video shows cause and effect, not just an error screen.
- **Compare like with like.** When "before" and "after" videos are compared, simulate the same condition in both; a failure staged in only one of them proves nothing about the change.
- **Say it in the report to the user**: which scenarios staged a failure, and that the errors they caused were expected.

Captions are in English, for a person who has not seen the code: "Choose size M", not "click combobox". Check what the user would notice, and also the server's state when the screen alone would not prove it. A check passes on elements outside the viewport too, so scroll what it is about into view with `await el.scrollIntoViewIfNeeded()`: here it scrolls smoothly and leaves the element clear of the caption.

Write ordinary Playwright actions. The recorder makes them look unhurried by itself: the pointer travels to the element along a slight curve, the page scrolls smoothly, `fill` and `pressSequentially` type character by character. This also changes what is tested for the better: `fill` really clicks and types, so an input mask or an autocomplete reacts as it does for a person. If a value typed that way comes out different, that is a finding, not a reason to go back to pasting. `human: false` in the run options turns this off, `typeDelayMs` sets the typing pace. Use `page.mouse` only when the gesture itself is under test (a drag): the recorder doesn't plan its path.

Every scenario starts in a clean browser context, so it signs in again. Do that through the API (`context.request.post(...)`) before the first step, when the app reads its session from cookies. An app that keeps its session in browser state needs the sign-in form: use a throwaway test account, as a visible step.

A scenario that changes data can be recorded once. To re-record it, return the test data to its starting state, and describe how in `scenarios.md`.

### 6. Run it

```bash
cd ~/test-videos/<project>/<task>/tests && node run.mjs
ONLY=S2 node run.mjs    # re-record one scenario
```

Run it in the background rather than waiting on the Bash tool: three scenarios take about 2.5 minutes, and each extra screen adds as much again. On the first run in a fresh skill folder, run `npm install` and `npx playwright install chromium` in the skill's directory. Exit code 1 means a scenario failed, 2 that the run hit its time limit (3 minutes per scenario, at least 10 in all; `deadlineMs` changes it). A scenario without a single `check` counts as failed.

The report always covers all scenarios of the test and is rewritten after each one, so an interrupted run leaves a true report. A scenario that was not re-recorded keeps its old result, with its own date and versions. After a code change, re-record everything the change touches before calling the result current.

### 7. Watch the result before reporting

Read `results/report.md`, then look at the images in `results/frames/` with the Read tool: the right screen and the right address in the bar, captions readable, nothing cut off, no personal data. The clock in the bar lets you find a moment from the report in the video. The frames show only the moments of checks, so also look through the rest of each video on a contact sheet, especially where something is typed. The sheet takes up to 40 frames spread over the whole video, so the end is never cut off:

```bash
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 video/s1.mp4); n=$(( ${d%.*} + 1 )); n=$(( n < 40 ? n : 40 ))
ffmpeg -y -v error -i video/s1.mp4 -vf "fps=$n/$d,scale=400:-1,tile=5x$(( (n + 4) / 5 ))" -frames:v 1 <scratchpad>/s1.png
```

For a phone's vertical video use `scale=200:-2,tile=10x$(( (n + 9) / 10 ))`.

Treat console errors and 5xx listed in the report as findings, even if every check passed: they catch what assertions miss, such as a component that failed to render. Those marked `[during simulation: …]` were caused by the test's own `simulate()` and are expected; an error outside a simulation still is a finding.

If a scenario fails, decide whether the code or the test is wrong. Fix it and re-record. Never loosen a check just to get a green video, and never present a failed run as a pass. If you keep a video of a real defect, say so plainly.

### 8. Report

Give the folder path, the result per scenario, and what was not covered. Link the videos by full path. Name what was not exercised for real, such as a payment stub instead of the real provider, and every failure a scenario staged with `simulate()`.

## Privacy and safety

- Test data only. Real participants' names, phones and emails do not belong in a video, because videos get forwarded.
- The recorder draws its own pointer and click circle and does not use `page.screencast.showActions`: that one always draws the action's title, which quotes typed values (`Fill "<password>"`), even in a masked field and even with `fontSize: 0`. Keep it that way, and check the video for anything sensitive anyway.
- No secrets in `tests/` or on screen. They live in the registry (step 3), and the recorder replaces their values with `***` in the report. Sign in through the API. When the sign-in form itself is under test, use a throwaway test account: the field stays masked, and a login typed into a visible field does show in the video.
- Traces record requests, cookies and typed values, so they stay local and are never sent to a client. Send only the mp4.
- Do not upload a video or send it to anyone without the user's explicit agreement.

## Reference

Runtime: `scripts/recorder.mjs` (Playwright `page.screencast`, pinned in this skill's `package.json`), `scripts/api-console.mjs` (the API pane's client page, served on a made-up `api-client.localhost` address by `context.route`), `scripts/browser-chrome.mjs` (the browser bar: tracked during the run, rendered by Chromium into PNGs and stacked over the video by ffmpeg, so no ffmpeg `drawtext` is needed), and ffmpeg for mp4 and frames. Without ffmpeg the video stays as webm, without the bar and without frames. If the bar can't be drawn, the video is made without it and the run says so. Video time zero is the first frame the screencast delivers, so the report's times, the bar's clock and the frames match the video. Captions disappear after `page.setContent`, so open a real address in scenarios. `timezoneId` is the system's by default; set it when the app's dates depend on it. Exit codes: 1 a scenario failed, 2 the time limit, 3 nothing was recorded. Run options: `outDir`, `title`, `scenarios`, and optionally `environment`, `commits`, `baseURL`, `timezoneId`, `only`, `headless`, `credentials`, `credentialsFile`, `preflight`, `viewports`, `browserChrome`, `human`, `typeDelayMs`, `stepPauseMs`, `checkPauseMs`, `contextOptions`.
