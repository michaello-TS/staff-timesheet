# Tests

Offline tests. Nothing in here talks to Google, the live web app or Notion.

```bash
cd tests
npm install                      # once: installs Playwright
npx playwright install chromium  # once, on a new machine
npm test                         # backend + browser tests
```

`npm run test:backend` (fast, under a second) or `npm run test:frontend` (headless Chromium, ~40 s) run one half.

## What runs

| Folder | What | How |
|---|---|---|
| `harness/` | `gas.js` loads a `Code.gs` into Node with stand-ins for SpreadsheetApp (an in-memory sheet that converts dates/times/numbers and parses `=`/`+`/`-` text the way Sheets does, and evaluates the column M formula), Properties, Cache, Lock, Mail, UI alerts, Content/HtmlService. `notion.js` is a fake Notion API with Notion's documented limits (25 items per page view, 2000 characters per text part, 100 links per update). | — |
| `backend/original-35.test.js` | The 35 backend checks from the October 2026 health check, run against **both** backends. On the deployed one, the bug checks confirm the bug is still there; on the new one, they confirm the fix. | `node --test` |
| `backend/new-fixes.test.js` | One or more checks for every fix added in PR #2 (I1, D2 replay guard, N1, N2, N3, L5, L6, L8, menu and dialog callbacks). | `node --test` |
| `frontend/ui.test.js` | `index.html` in Chromium at phone size. Every `script.google.com` request is answered by the **real** `Code.gs` running in the harness, or dropped to simulate a lost reply. The 8 front-end checks from the health check, plus the safe-submit paths. The new page is tested against **both** the deployed and the new backend, and the old page against the new backend. | Playwright |

## Fixtures

- `fixtures/Code.deployed.gs` is the backend that was live before PR #2 (`main` @ `d40913a`), with fake Notion database IDs.
- `fixtures/index.deployed.html` is the page that was live before PR #2, with a fake deployment URL.

They exist only so the tests can prove the new page still works with the old backend, and the other way round. Never paste them anywhere.
