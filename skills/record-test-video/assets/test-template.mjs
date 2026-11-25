// Copy to ~/test-videos/<project>/<task>/tests/run.mjs. Run: node run.mjs (ONLY=S2 re-records one scenario).
// No secrets in this file: logins and passwords come from ~/test-videos/<project>/credentials.env, as creds.
import { homedir } from 'node:os';

const { runScenarios, expect, faults } = await import(`${homedir()}/.agents/skills/skills-catalog/record-test-video/scripts/recorder.mjs`);

await runScenarios({
  outDir: '~/test-videos/<project>/<task>',
  title: '<TASK-ID>: <what we check>',
  environment: 'local (test database)',
  commits: 'api abc1234, web def5678',
  baseURL: 'http://localhost:3000',
  // Screens for every scenario, a scenario can set its own. Default 'desktop'; also 'phone', '1920x1080', { id, label, width, height, mobile }.
  // viewports: ['desktop', 'phone'],
  // A browser bar with the URL, the clock and checks/errors is drawn above every video; browserChrome: false turns it off.
  // Everything the scenarios sign in with. A missing one stops the run before the browser starts.
  credentials: {
    LOCAL_USER_EMAIL: 'regular participant, local stand',
    LOCAL_USER_PASSWORD: 'their password',
  },
  // Throw when the credentials or the stand won't do: nothing is recorded then.
  preflight: async ({ creds, request }) => {
    const response = await request.post('/auth/login', { data: { email: creds.LOCAL_USER_EMAIL, password: creds.LOCAL_USER_PASSWORD } });
    if (!response.ok()) throw new Error(`Sign-in as LOCAL_USER_EMAIL fails: ${response.status()}`);
  },
  scenarios: [
    {
      id: 'S1',
      title: 'Scenario name',
      expected: 'What should happen, in one sentence',
      run: async ({ page, step, check }) => {
        await step('Open the page', () => page.goto('/'));
        const title = page.getByRole('heading', { level: 1 });
        await check('The heading is there', () => expect(title).toBeVisible(), { highlight: title });
      },
    },
    {
      id: 'S2',
      title: 'A change in the admin shows on the site',
      expected: 'What should happen, in one sentence',
      panes: [{ id: 'admin', label: 'Admin', baseURL: 'http://localhost:8080' }, { id: 'site', label: 'Site' }],
      run: async ({ panes: { admin, site } }) => {
        await admin.step('Open the admin', () => admin.page.goto('/'));
        await site.step('Open the site', () => site.page.goto('/'));
        // ...change it in admin, then show the result in site:
        const price = site.page.getByTestId('price');
        await site.check('The site shows the new price', () => expect(price).toHaveText('$1,900'), { highlight: price, note: 'Changed from the admin' });
      },
    },
    {
      id: 'S3',
      title: 'An order created through the API',
      expected: 'POST /orders answers 201 with the order in status new',
      kind: 'api', // a request client on screen instead of a site; in panes: { id: 'api', label: 'API', kind: 'api', baseURL }
      run: async ({ send, ui, step, check, creds }) => {
        const login = await step('Sign in as the test user', () => send({ method: 'POST', url: '/auth/login', body: { email: creds.LOCAL_USER_EMAIL, password: creds.LOCAL_USER_PASSWORD } }));
        const token = login.json().access_token;
        const res = await step('Create an order', () => send({ method: 'POST', url: '/orders', headers: { Authorization: `Bearer ${token}` }, body: { item: 'Racket', qty: 2 } }));
        await check('The server answers 201 Created', () => expect(res.status).toBe(201), { highlight: ui.status });
        await check('The order is new', () => expect(res.json().status).toBe('new'), { highlight: ui.field('status') });
      },
    },
    {
      id: 'S4',
      title: 'The order page copes with a lost connection',
      expected: 'Offline (simulated by the test): an error with Retry; back online: Retry loads the order',
      run: async ({ page, step, check, simulate }) => {
        await step('Open an order', () => page.goto('/orders/1'));
        await check('The order is shown', () => expect(page.getByRole('heading', { name: /Order/ })).toBeVisible());
        // a staged failure: shown as staged on screen and in the report, never a bare page.route / setOffline
        const end = await simulate('No internet connection', faults.offline());
        await step('Reload the order', () => page.getByRole('button', { name: 'Refresh' }).click());
        const retry = page.getByRole('button', { name: 'Retry' });
        await check('An error with Retry, not an empty page', () => expect(retry).toBeVisible(), { highlight: retry });
        await end();
        await step('Back online: click Retry', () => retry.click());
        await check('The order is shown again', () => expect(page.getByRole('heading', { name: /Order/ })).toBeVisible());
      },
    },
  ],
});
