# Business console checks

`npm run build` type-checks and builds the production console. `npm test` runs the draft-merge, schema, map-merge and truthful action-feedback regressions.

The optional `npm run test:browser` regression uses Playwright. Install/provide Playwright separately, start `npm run dev -- --port 5179 --strictPort`, then run the browser test. Set `PLAYWRIGHT_MODULE` to an absolute module path if your development runtime supplies Playwright, and `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. `CONSOLE_TEST_ARTIFACTS` selects the screenshot directory (default `test-results/merchant-flow`).

All API requests in this browser test are intercepted fixtures. It exercises account-mode navigation, sign-in, versioned autosave, exact preview rendering, explicit approval, visible publication failures, idempotent retry, persistent queued feedback, empty location search and the private-draft gate. It also checks the desktop/mobile palette, mobile overflow, and browser exceptions. It does not assert a real delivery, account, payment, or external publication. Use the platform integration suite for real database and worker acceptance.
