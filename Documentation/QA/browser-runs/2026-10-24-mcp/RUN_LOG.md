# MCP local first-party browser acceptance — 24 October 2026

Real user Chrome 155 through `http://100.108.68.20:9222`; one owned tab (`883F5DFA6F332B67261935B87412BF54`) reused throughout and closed at the end. No existing tab was navigated or closed. Only fabricated local accounts and configured gym mock links were used; no live gym writes or reads, payments or production deployment occurred.

## Before evidence

- Missing authorization/connection implementation confirmed in the code. An isolated local fixture returned 404 at `/mcp/authorize`; Chrome displayed “MCP authorization and connections are not implemented”.
- Real PWA Account page, served by Vite and the local mock server, showed Account Password, Account Session and Delete All My Data with no AI connection link. After the new code but with both feature flags off, the new card remained hidden (`checkVisibility() === false`).

## After evidence

- SA password sign-in occurred on the first-party page. All scope and gym checkboxes were initially unchecked. Selecting only account reads and one gym generated the callback code. Screenshot: [consent](consent.png).
- Cross-origin callback tested between `https://100.86.226.52:3189` and `https://100.86.226.52:3191`, using the same real Chrome. State matched exactly. The actual MCP SDK exchanged the browser-issued code with its PKCE verifier, initialized protocol 2025-11-25, listed the one permitted local-only tool (provider reads off) and read only the one approved gym. No token or code is recorded here.
- Connections page showed the selected scope/gym, 30-day expiry and last use. Screenshot: [connections](connections.png). Revoke removed the grant from the page; the same access token then received 401 and its refresh token received 400.
- The actual PWA Account page showed Manage AI connections when both runtime flags were on. Screenshot: [Settings](settings.png). Browser service worker, CacheStorage and IndexedDB for the fixture origin were cleared before reload; user-wide browser caches were not cleared.
- Mobile emulation at 390×844 showed a 390px document width without horizontal overflow. Screenshot: [mobile sign-in](mobile.png). This is real Chrome device emulation, not actual iOS acceptance.

## Browser-only defects found and fixed

1. `Referrer-Policy: no-referrer` made navigation form POSTs emit `Origin: null`, so strict CSRF origin validation rejected real sign-in despite passing HTTP tests. `same-origin` preserves the first-party Origin while suppressing cross-origin referrers.
2. Chrome enforced consent `form-action 'self'` across the OAuth callback redirect. Consent pages now add only their immutable preregistered callback origin to that directive; login and connection-management forms remain self-only. Real cross-origin redirect succeeded after the change.

## Reproduction and local fixture lifecycle

The isolated fixture implementation/driver were left at `/tmp/mcp-browser-fixture/run.cjs`, `cdp.cjs` and `sdk.cjs` for the next development agent. These are temporary tooling, not application dependencies. Temporary keys and fabricated account credentials stay outside the repository. Do not print their contents or reuse them publicly.

- Runtime: `/home/ubuntu/.npm/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node` (20.20.2).
- Fixture HTTPS listeners: tailnet-only `100.86.226.52:3189` and `:3191`. The fixture mounts the real authorization/resource modules with a fabricated local account, two independent HTTPS origins, no provider reads and an operator-pinned temporary signing key. Its fallback proxies `/api` to the local mock server on 3190 and other app assets to Vite on 5178.
- PWA backend: repository `server/server.js`, Node20, port3190, `DB_PATH=/tmp/mcp-browser-fixture/pwa.db`, mock gyms enabled, throwaway encryption key, and temporary MCP key/client files in the fixture directory. The local browser fixture's auth DB is separate from the PWA mock DB; the production app uses its one real DB. The Settings link test verifies navigation/gating, while authorization tests prove local-account binding separately.
- Vite: `client/node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178`.
- Driver tasks: `node /tmp/mcp-browser-fixture/cdp.cjs consent`, `revoke`, `mobile`, `settings`. SDK tasks (Node20): `sdk.cjs connect`, then `sdk.cjs revoked`. To rerun, create a new owned tab and update `/tmp/mcp-owned-tab.json`; the recorded tab has been closed.
- The self-signed fixture TLS exception was handled only through the owned tab's Security domain and reset after each drive. No global Chrome certificate setting was changed. Tailscale certificate acquisition was unavailable; no Tailscale account/operator configuration was changed.

All owned listeners are stopped at handoff. This fixture does not prove the intended production proxy, actual ChatGPT/Claude accounts, or valid public HTTPS. Those remain explicit release gates.
