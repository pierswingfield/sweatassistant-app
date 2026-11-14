# Initial manifest handoff: supporting WebKit test

## Latest guard build — 2026-11-13

Asset `index-iuCg2AGb.js`, SHA-256 `8d8c1abc6829441ca56cc9a480361b7100fc0a06ec1874530f4ef697de6d3936`, was tested against a disposable local production fixture in iPhone 15 Pro standalone WebKit emulation. This supports verification but does not prove the physical iPhone flow. The parent reported 129 server suites and 1,043 client tests passing for this build; those full suites were not rerun in this check.

The initial HTML and opaque manifest both returned 200. After clearing localStorage, sessionStorage, IndexedDB, CacheStorage and service workers, its launch showed the Team preview before authentication. New-account setup proceeded through gym-skip, name and features to a visible [Team welcome](guards-final-welcome.png), with Home hidden. Reopening the original spent launch URL returned `/` without query, pending invite, preview or welcome. Emulator logs reported zero page exceptions and zero network failures; two initial 403 responses occurred before clearing the previous emulator session, followed by no-gym 409s and timetable/profile refresh errors during this fixture.

The independent deferred-response reproductions were rerun from the project root with `bash Documentation/QA/browser-runs/initial-manifest-webkit-2026-11-13/guard-repro.sh` (Node 22.23.4):

```
PASS delayed Team A redemption preserves newer Team B
PASS delayed account A lookup cannot write intent after switch to B
PASS delayed Team A manifest does not overwrite newer Team B
```

[Structured result](results-guards-final.json). Fixture credentials and invitation tokens are not recorded.

## Previous build — 2026-11-13

Production-built asset `index-CaEQJezN.js`, SHA-256 `b8ad5d9afa7aa4cc236baf975cd72b84a50d922130969c879b4defe2bf91b673`, was tested using the iPhone 15 Pro standalone WebKit emulator and a fresh disposable local database. This is supporting emulation, not a physical iPhone test.

- Initial Team HTML and opaque manifest both returned 200. After clearing localStorage, sessionStorage, IndexedDB, CacheStorage and service workers, the manifest launch showed the [Team preview before authentication](latest-preview.png); the query was removed.
- A new local account completed gym-skip, name and features setup and saw the [Team welcome](latest-welcome.png); Teams was visible and Home hidden.
- Opening the **original spent launch URL** again yielded `/` with no query, pending invite, preview or welcome.
- While signed in and with no local install metadata, a hard navigation to a separate Team link showed its [welcome](latest-signed-in.png). A repeated isolated navigation produced one continuation POST with HTTP 200 and left zero rows in the local continuation table; it began with zero rows.
- Emulator debug logs reported zero page exceptions and zero network failures. They also contained no-gym 409s for profile, credits and eligibility and a profile refresh error; these were not treated as passes.

[Latest structured result](results-latest.json). The local production server used Node 22.23.4, a generated fixture encryption key and the disposable `/tmp/dibs-initial-manifest-latest-20261113.db`. No credentials or invitation tokens are recorded.

## Previous build — historical

On 2026-11-13, the iPhone 15 Pro standalone WebKit emulator tested the production-built local app against a disposable local database. This is supporting emulation, not a physical iPhone or a substitute for the required real-browser verification. No gym account was linked.

The Team invite HTML returned 200 and included an opaque continuation in its initial manifest URL. The manifest returned 200 with a launch continuation. After clearing localStorage, sessionStorage, IndexedDB, CacheStorage and service workers, opening that launch URL showed the [Team preview](preview.png) before authentication; redeeming the continuation again returned no invite. Creating a new local account, skipping the gym, entering a name and finishing setup showed the [Team welcome](welcome.png), with Home hidden. An ordinary root relaunch did not reopen the invitation; the existing gym-less onboarding intro appeared.

The emulator reported zero page exceptions and zero network failures. Its cumulative console logs included three 403s during the initial navigation before prior emulator storage was cleared, and no-gym 409 responses and booking/profile prefetch errors during the fixture flow. [Structured result](results.json). No credentials or invitation tokens are recorded here.
