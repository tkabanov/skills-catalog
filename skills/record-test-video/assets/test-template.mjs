// Copy to ~/test-videos/<project>/<task>/tests/run.mjs. Run: node run.mjs (ONLY=S2 re-records one scenario).
// No secrets in this file: logins and passwords come from ~/test-videos/<project>/credentials.env, as creds.
import { homedir } from 'node:os';

const { runScenarios, expect } = await import(`${homedir()}/.agents/skills/skills-catalog/record-test-video/scripts/recorder.mjs`);

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
  ],
});
