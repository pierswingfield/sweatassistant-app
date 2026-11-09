# Policy email protection fix — 9 November 2026

Experiment-only deployed fix on uncommitted `feat/optional-gym-login-policy`, based on `43592ebb7feb84c4e9a676c122909e5fe632ecda`. No push or merge.

## Cause and change

The origin policy files contain `privacy@dibs.fit`. Cloudflare Email Address Obfuscation rewrote them into `[email protected]` links to `/cdn-cgi/l/email-protection`. Direct document navigation ran Cloudflare's deferred decoder, but `client/src/ui/policies.js` fetches HTML, parses it with DOMParser, and imports only `<main>` into the reader. The decoder does not run in this path. Both embedded policy readers reproduced the reported failure in the user's real Chrome before editing.

`server/server.js` now sets `Cache-Control: no-cache, no-transform` only for Terms and Privacy HTML, including dated copies. Cloudflare documents that no-transform prevents email obfuscation: [primary documentation](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/). All address occurrences in the four policy HTML files are explicit readable `mailto:privacy@dibs.fit` links. No decoder, dynamic script execution, wider Cloudflare setting, CSP change, or reader HTML-decoding logic was added. Policy wording and accepted versions are unchanged.

## Verification commands and actual results

Raw output is retained locally beside this receipt; chat reports remain concise.

- `node check-browser.cjs` (Chrome CDP, experiment, before deployment): [browser-red.txt](browser-red.txt), **2/16 checks passed**, fourteen exact contact/no-transform failures, including both embedded readers. [before-checks.json](before-checks.json), [raw/public comparison](comparison-before.json), [origin evidence](origin-before.txt).
- Node 22.23.4 `node server/test-security-headers.js`: [before fix](regression-red.txt) fails on `no-cache` versus `no-cache, no-transform`; [after fix](regression-green.txt) **ALL PASS test-security-headers**. Tests use the actual Express static route and actual published policy files, all four contacts, 200/304 headers, and unchanged immutable asset caching. The first conditional-request harness used fetch, which adds cache-bypass headers; it was corrected to plain HTTP before the successful regression/full-suite run.
- Node 22.23.4 `npm test`: [npm-test.txt](npm-test.txt), **124/124 server suites passed; 123/123 client files and 990/990 tests passed**.
- Node 22.23.4 `npm run build:client`: [build.txt](build.txt), **built in 965ms**. Existing Vite static/dynamic import and large-chunk warnings remain.
- Explicit-GIT_DIR `git diff --check`: [diff-check.txt](diff-check.txt), **exit 0, no output**.
- `CAPTURE=after CLEAR_CACHES=1 node check-browser.cjs`: **16/16 passed** after unregistering the service worker, clearing CacheStorage/IndexedDB and reloading. An initial wait for `networkidle` timed out on reload; [attempt retained](browser-after-reload-timeout.txt). The harness now waits for document readiness and specific UI elements.
- Final screenshot capture with modal transition settled, `CAPTURE=after CLOSE_TAB=1 node check-browser.cjs`: [browser-green.txt](browser-green.txt), **16/16 passed**; [checks](after-checks.json), [Terms](after-terms.png), [Privacy](after-privacy.png). Direct current/dated documents and both embedded readers show the exact readable address and mailto href, without protected links. Signup acceptance checkbox state survives opening/closing either reader. One owned Chrome tab was reused and closed. No mail was sent or mail client invoked.

## Deployment and preservation

The reviewed [rsync delta](deployment-delta.txt) contained only the policy fix/test and documentation relative to the already-deployed feature tree. [Dry run](deploy-print.txt) explicitly targets `oracle:~/services/sweatassistant-experiment`, `docker-compose.experiment.yml`. [Actual deploy](deploy.txt) rebuilt and recreated only `sweatassistant-experiment`, client build 133 modules.

Fresh rollback directory on Oracle: `~/services/sweatassistant-experiment/rollback-policy-email-20261109/`, containing WAL-safe online `app.db`, mode-600 environment snapshot, experiment compose, and prior image ID. Prior image retained as `sweatassistant-experiment:rollback-policy-email-20261109`. [Pre-deploy checks](predeploy-preservation.txt) show integrity `ok`, **12 users/17 gym links**, and only bind-mounted `/data` in docker diff.

[Runtime checks](runtime-after.txt) show container **Up**, restart count **0**, Node **v22.23.4**, **arm64**, unchanged **100.86.226.52:3006→3000** bind, and both `edge` and experiment project networks. Internal health HTTP **200**, [public health](public-health.json) status **ok**, scheduler/poller/calendar healthy. DB integrity **ok**, **12 users/17 links preserved**; environment and compose compare equal to the fresh snapshots. [Local hashes](local-hashes.json) match all six deployed server/shell/policy hashes. No production, dev, marketing, DNS, Access, port, or live gym action was performed.

No physical iPhone was available. Real desktop Chrome at a 390×844 viewport verifies the same reader and public edge response; installed iPhone PWA/mail-app handoff remains a device follow-up. Reopening the reader online fetches the corrected document; reinstalling the PWA is not needed for this response-header/content fix.

Gemini provenance: two Flash locator calls for mandatory instructions/deployment references and one grounded primary-doc lookup. Owning code, real HTTP/browser behavior, and Cloudflare documentation were independently verified.
