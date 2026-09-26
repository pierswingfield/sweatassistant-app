# Agent protocol: verify first, then change

**This applies to every item in every workstream, for humans and agents alike.** The
backlog was built from docs, QA runs and session notes. When it was consolidated on 2026-09-26,
several "open" items turned out to be done already, and two "done" items were still broken.
Treat each item as a **claim to check**, not an instruction to execute.

## The rule

> **Do not change code until you have confirmed the basis of the bug or change yourself, and
> recorded the evidence.** If you cannot confirm it, do not change anything: report it as not
> reproduced.

## Steps for every item

### 1. Verify the basis (before touching code)

1. **Code check.** Confirm the code path the item describes still exists and still behaves as
   described. Line numbers in the workstream docs are hints; search by symbol. If the item turns
   out to be already fixed, mark it done with the evidence (`file:line`) and stop.
2. **Real-browser check.** This is required for anything user-visible or client-side. Reproduce the
   bug in a real browser (see **Browser access** below):
   - Local mock: `npm run dev` (server :3000, client :5173), then log in as `dev@psycle.com` with
     any password.
   - Live data: the dev twin `sweat-dev.wingfield.tech`. Any live gym write follows
     [`LIVE_VERIFICATION_PLAYBOOK.md`](../LIVE_VERIFICATION_PLAYBOOK.md).
   - Capture evidence: a screenshot, the console error, and/or the network request and response.
3. **Server-only items** (no UI surface): reproduce with a failing test, a request against the
   local server, or a log line. You still need evidence before changing code.
4. **Write down the root cause** in the workstream item (one or two lines) before fixing.
5. **Can't reproduce?** Don't change code. Add a dated "not reproduced" note to the item, saying
   what you tried, and report it.

### 2. Change

- Where practical, write the failing test first. It should fail for the reason you recorded in
  step 1.4.
- Keep the change scoped to the item. Log anything else you notice as a new item; don't fold it in.

### 3. Re-verify (after the change)

1. `npm test` must be green. Server suites need Node 20 and `ENCRYPTION_KEY`; see
   [`TESTING.md`](../TESTING.md).
2. Repeat the **same real-browser check** from step 1.2 and capture the same kind of evidence,
   now showing the fix. Clear all three client caches first (service worker and CacheStorage,
   IndexedDB, and a real reload, not a hash-route change).
3. Update the item: tick it, add the date, and link the evidence. A UI change with no
   after-evidence from a real browser is not done.

## Browser access (required; fail hard without it)

Use the user's real Google Chrome. It holds the signed-in sessions the app needs. Two routes:

| Route | Who | How |
|---|---|---|
| **Chrome DevTools Protocol, port 9222** | Any agent (Claude, Codex, scripts) | Check with `curl -s http://127.0.0.1:9222/json/version`. Attach with a CDP client, e.g. Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')` or Puppeteer `puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })`. |
| **Claude for Chrome extension** | Native Claude Code agents | The `claude-in-chrome` tools. The extension is installed and signed in, in Google Chrome. |

**If neither route works, stop and report:**

```
BLOCKED: no real-browser access — CDP 127.0.0.1:9222 unreachable and Claude for Chrome unavailable.
Item <ID> not verified; no changes made.
```

None of these count as a substitute: jsdom or vitest, `curl` of the HTML, a fresh
headless browser launched without the user's profile, or reading the code and concluding it
"should" work. Those are useful supporting evidence, but they are not the browser check.

Etiquette in the user's browser: open your own tabs and close only those. Don't navigate or close
the user's existing tabs. Don't interact with unrelated sites.

## Gemini offload: use it wherever it fits

Gemini's lanes are subscription-backed and effectively free. Claude and Codex tokens are the
scarce resource. Use the `gemini-offload` skill (`gemini-delegate` CLI) wherever the work is reading
or summarising rather than proving.

| Use Gemini for | Don't use Gemini for |
|---|---|
| Reading the archive (`Archive/2026-09-26/`, especially the 280 KB `PROGRESS.md`) for history and decisions behind an item | **Browser verification**: Gemini has no browser tools |
| Triaging QA run logs, transcripts and large test output | The evidence itself for a specific bug. It summarises, and the one anomalous line gets dropped. |
| Finding where something lives across many files before you grep the exact lines | Writing code against exact signatures |
| Files over ~80 KB (`timetable.js`, `main.js`, `styles.css`): ask for a structural map | Security review |
| Drafting doc and status updates; current library or API facts (`-m grounded`) | Final judgement on whether an item is done |

The pattern: **Gemini locates → you read the exact lines → the browser proves it.** Treat Gemini
output as a claim, and confirm it before relying on it.
