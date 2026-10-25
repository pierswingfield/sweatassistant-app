# MCP mobile UI regression — 25 October 2026

The user's initial physical iPhone Safari check found the AI connection list readable, but the sign-in form clipped. Returning to the app resumed unfinished onboarding; after entering Home, widget errors flickered rapidly and prevented normal navigation. After independent review and isolated app deployment of `7eee61b`, the user physically retested Safari and reported: Home remained stable after ten seconds, Home/Settings navigation responded, login fields fit, and keyboard scrolling reached the submit button. These reported checks passed. The separate phone consent-checkbox layout check remains pending; phone approval/revocation and installed-PWA behavior are not claimed.

## Verified before changes

In the user's real Chrome through the supplied tailnet CDP endpoint, an owned staging `/oauth/connections` tab at a 390px mobile viewport placed both input right edges at 397.6px. The body inherited the mobile PWA shell's `overflow:hidden!important`. Inputs used content-box width 100% plus horizontal padding/borders. No password or account identifier was read.

The desktop staging root was behind an expired Cloudflare Access session, so Home was reproduced in a local fixture in the same real Chrome, not by changing staging authentication. The fixture imports the actual Home/Favourites/timetable modules, supplies a synthetic linked gym and API methods that return a disabled-provider error, and includes the Home and timetable containers. Home's Favourites loader calls `ensureScheduleLoaded()` whenever there are no events; timetable completion/error dispatches `app-timetable-rendered`, which renders Home again. The fixture reached nine load attempts/eight completion events in 2.5 seconds; it deliberately held the ninth promise to bound the failing browser loop. A deterministic regression independently failed its expected-one-load assertion before the fix.

## Source fix and re-verification

Implicit timetable bootstrap is remembered for the account, sorted linked-gym set, date and configured prefetch span. Failed and successfully empty loads settle without treating absence of rows as permission to fetch again. Explicit timetable refresh/retry remains available, and account/gym/window changes permit a new bootstrap; gym-reset clears the marker.

Standalone OAuth documents have scoped HTML/body classes and scroll independently of the fixed PWA shell. Their controls use border-box sizing, text inputs use at least 16px text, and the content can wrap. The existing mobile shell rule excludes these standalone documents; normal PWA scrolling rules remain applicable to the PWA.

After clearing service workers, CacheStorage and IndexedDB only for the owned local fixture origins and reloading, the same real-Chrome Home fixture made one load/one completion. Its Settings control responded to trusted keyboard and pointer input and hid Home. The regression covers denied loads, valid empty success without a hidden exception, explicit retry, account/gym changes and a new date window.

The actual authorization router served the changed sign-in HTML/CSS in an isolated in-memory local HTTP fixture. In real Chrome, all fields and buttons fit at 320×568, 390×844 and 1024×768. A 390×320 reduced viewport allowed scrolling to the Back link; inputs stayed inside the viewport with computed 16px text. No real account login, OAuth approval, provider request or existing browser-storage clearing occurred. The fixture servers and owned browser tab are task-owned and removed after verification.

These are supporting Chrome/mobile-viewport checks, **not** substitutes for physical Safari. The later user-reported physical pass above is separate evidence. It covers Home/navigation and management sign-in keyboard/layout, not consent-checkbox layout or completed phone authorization.

Validation on pinned Node 20.20.2 with the documented in-memory DB and London test timezone: full `npm test` passed 102 server suites and 95 client files/712 tests. Production `npm run build:client` passed. The new regression was observed red before the fix and green afterward. No staging deployment was performed.

## Back navigation

The link says “Back to the app” and targets `/`. Existing cold-boot routing resumes optional onboarding when setup remains incomplete and has not been dismissed. The observed onboarding return matches that contract; no onboarding data or completion flags were changed to hide it. Returning specifically to Settings was an incorrect test expectation, not the implemented link behavior.
