---
name: record-test-video
description: Record videos of test scenarios in a real browser, with captions and real checks, and keep them with the scenario descriptions, the tests and a results report in ~/test-videos/<project>/<task>/. Use it only when the user asks to record, show or prove how something works, wants a demo for a client, a test video, a screencast or video evidence ("record a video", "show how it works", "test video", "demo for the client"). Don't use it on your own after finishing a feature: only on request.
---

# Record test video

A finished UI feature gets a short video per scenario, so the owner and the client can watch it work instead of taking a written "it works" on trust. The video is evidence only because real checks run while it records: a failed check fails the scenario, and the video shows that.

A video does not replace unit tests or e2e checks, and it is not diffable. Keep scenarios few and meaningful.

## When to skip

No video for backend-only changes, refactors, or small tweaks with nothing new to show. Say so in your report instead of recording something empty.

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

Write in the language of the user and their client; here that is Russian. Include the unhappy paths that matter (sold out, refused, wrong input), not only the happy one. Three to six scenarios of 20-60 seconds each are usually enough.

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
- also `page`, `context`, `request`, `creds`.

**Show the result, don't just assert it.** On the check that proves the scenario's point, pass `{ highlight: locator, note: 'Now' }`, or an array of locators: once the check has passed, the rest of the screen dims and a ring is drawn around the element, red if the check failed. Use it on the few moments that matter. When everything is highlighted, nothing is. A `highlight()` on its own is not evidence, so don't let it stand where a check belongs.

**Show several systems at once.** When a change in one system should appear in another, give the scenario `panes: [{ id: 'admin', label: 'Admin' }, { id: 'site', label: 'Site' }]`. They record side by side in one video on one clock, each with its own browser session, and a frame marks the one being acted in. `run` gets `panes: { admin, site }`, and each has its own `page`, `context`, `request`, `step`, `check` and `highlight`. Open every pane in the first steps, so that no half of the video stays blank, and leave the receiving side on screen while the other changes it. Then the viewer sees cause and effect, not two separate stories. Two panes make a 2564 px wide video: use them where the link between the systems is the point.

**The browser frame.** Each video has a browser bar drawn above the page: the tab with the page title, the address bar with the current URL (a lock for https, "Not secure" for plain http away from localhost), a loading indicator, and chips for a tester: the clock, which reads the same as "Time" in the report, checks passed ✓ and failed ✗, console errors and 5xx so far, the scenario id, the screen and the environment. With several panes each pane has its own bar with the pane's name, and the active pane's bar turns blue. A phone gets a compact two-line bar. The bar sits above the page, not over it, so it hides nothing, and the video is 80 px taller (64 on a phone). The address is part of the evidence: a check that a page opened is more convincing when the viewer sees which URL it is. Values of query parameters that look secret (`token`, `key`, `code`, `password`, `session`...) show as `***`, and so do the registry's values. A secret anywhere else in the path does show, so look at the bar on the contact sheet. `browserChrome: false` in the run options turns it off.

**Choose the screens.** By default a scenario records on a desktop, 1280x800. Set `viewports` in the run options for all scenarios, or on one scenario: `'phone'`, `['desktop', 'phone']`, `'1920x1080'`, or `{ id: 'tablet', label: 'tablet', width: 768, height: 1024, mobile: true }`. Take what the task or the user names; otherwise judge by who uses this screen, and add the phone where participants work from one. Each screen is its own video and its own line in the report, with the id `S1-phone`, and `ONLY=S1` re-records all of a scenario's screens. A scenario that behaves differently can read `viewport` (`id`, `width`, `mobile`). `'phone'` is Pixel 7 emulated in Chromium, with touch and a mobile user agent: it shows layout and touch, not the quirks of a real device or of Safari, so name that in the report. Use `locator.tap()` where the tap itself is what you test. Panes take their own screen too: `panes: [{ id: 'admin', label: 'Admin', viewport: 'desktop' }, { id: 'site', label: 'Site', viewport: 'phone' }]`.

Captions are for a person who has not seen the code: "Choose size M", not "click combobox". Check what the user would notice, and also the server's state when the screen alone would not prove it. A check passes on elements outside the viewport too, so scroll what it is about into view with `await el.scrollIntoViewIfNeeded()`: here it scrolls smoothly and leaves the element clear of the caption.

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

Treat console errors and 5xx listed in the report as findings, even if every check passed: they catch what assertions miss, such as a component that failed to render.

**Recording artifacts.** Some things look wrong in a video and are not in the app. Before reporting one as a defect, repeat it by hand in a real browser, with the mouse, the wheel and the keyboard. Known artifacts, both fixed in `scripts/recorder.mjs`; if one comes back, the cause is the recorder:

- *Captions, the highlight or the pointer under a drawer.* A modal `<dialog>` and a popover live in the browser's top layer, above every `z-index`, under their blurred backdrop. Playwright's overlays live in its own popover (`<x-pw-glass>`), raised only when it is installed, so a dialog opened later covered them, and the recorder's own pointer was a plain `z-index` element. Now the pointer and the click marks are popovers, and whenever the page opens something in the top layer (`showModal()`, `showPopover()`, `togglePopover()`, a `popovertarget` or `commandfor` button, full screen) the glass and then the pointer are shown again, which puts them on top. A dialog opened from markup is caught by its `toggle` event a moment later, so its first frame may still cover them.
- *A drawer slides up, or the page scrolls further than a person can.* `element.scrollIntoView()` scrolls every ancestor, `overflow: hidden` ones too, which no wheel can. A drawer whose `<dialog>` is `overflow-hidden` but has a few hidden pixels of overflow (an absolutely positioned `sr-only` label whose containing block is the dialog, not the scrolling body) slid up in the video, its header cut. Now the recorder scrolls only boxes with `overflow: auto` or `scroll`, innermost first, on both axes and out of shadow roots, like a wheel; it leaves the page alone when the page is locked (`overflow: hidden` under a modal) or the element sits in a fixed box. Boxes scrolled by script with `overflow: hidden` (custom scrollbars, some virtual lists) are not touched: there Playwright scrolls on its own, and the old slide can come back. The hidden overflow is a real but harmless flaw of the page, worth a note to the developer, not a failed scenario.

If a scenario fails, decide whether the code or the test is wrong. Fix it and re-record. Never loosen a check just to get a green video, and never present a failed run as a pass. If you keep a video of a real defect, say so plainly.

### 8. Report

Give the folder path, the result per scenario, and what was not covered. Link the videos by full path. Name what was not exercised for real, such as a payment stub instead of the real provider.

## Privacy and safety

- Test data only. Real participants' names, phones and emails do not belong in a video, because videos get forwarded.
- The recorder draws its own pointer and click circle and does not use `page.screencast.showActions`: that one always draws the action's title, which quotes typed values (`Fill "<password>"`), even in a masked field and even with `fontSize: 0`. Keep it that way, and check the video for anything sensitive anyway.
- No secrets in `tests/` or on screen. They live in the registry (step 3), and the recorder replaces their values with `***` in the report. Sign in through the API. When the sign-in form itself is under test, use a throwaway test account: the field stays masked, and a login typed into a visible field does show in the video.
- Traces record requests, cookies and typed values, so they stay local and are never sent to a client. Send only the mp4.
- Do not upload a video or send it to anyone without the user's explicit agreement.

## Reference

Runtime: `scripts/recorder.mjs` (Playwright `page.screencast`, pinned in this skill's `package.json`), `scripts/browser-chrome.mjs` (the browser bar: tracked during the run, rendered by Chromium into PNGs and stacked over the video by ffmpeg, so no ffmpeg `drawtext` is needed), and ffmpeg for mp4 and frames. Without ffmpeg the video stays as webm, without the bar and without frames. If the bar can't be drawn, the video is made without it and the run says so. Video time zero is the first frame the screencast delivers, so the report's times, the bar's clock and the frames match the video. Captions disappear after `page.setContent`, so open a real address in scenarios. `timezoneId` is the system's by default; set it when the app's dates depend on it. Exit codes: 1 a scenario failed, 2 the time limit, 3 nothing was recorded. Run options: `outDir`, `title`, `scenarios`, and optionally `environment`, `commits`, `baseURL`, `timezoneId`, `only`, `headless`, `credentials`, `credentialsFile`, `preflight`, `viewports`, `browserChrome`, `human`, `typeDelayMs`, `stepPauseMs`, `checkPauseMs`, `contextOptions`.
