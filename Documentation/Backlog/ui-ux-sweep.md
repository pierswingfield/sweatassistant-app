# UI/UX, accessibility and design-system sweep

**Status:** findings only — nothing here is implemented. Raised 2026-09-14 during the modular-gyms
step 6 cleanup. Items are ranked by user-visible impact, not by effort.

Evidence figures are counts taken from the worktree on 2026-09-14 and will drift; re-measure before
committing to any of this.

---

## A. Things that are wrong now

### A1. No live region — ✅ FIXED 2026-09-14

`aria-live` appears **zero** times across `client/index.html` and every UI module. Toasts
(`main.js showToast`) are the app's only feedback channel for booking success, cancellation,
errors, push state and calendar changes, and they are appended to a plain `<div>`. A screen-reader
user books a class and is told nothing at all.

Fix: `role="status" aria-live="polite"` on `#psycle-toast-container`, `aria-live="assertive"` for
the `error` variant. Also give the SSE auto-book status updates a polite live region — they change
text in place, which is exactly the case live regions exist for.

**DONE.** Toasts now carry `role="status"`/`aria-live="polite"`, and `role="alert"`/`assertive` for errors.
Still open: the SSE auto-book status updates change text in place and have no live region.

### A2. Toast messages interpolate unescaped into `innerHTML` — ✅ FIXED 2026-09-14

`showToast` does `toast.innerHTML = \`…${message}…\``, and callers pass `err.message` straight from
server and provider responses. This is the same class of issue AGENTS.md already records for the
timetable, but the toast path is worse: it is reached from error handlers across every module, so
any provider that returns markup in an error string renders it.

Fix: `textContent` for the message span; the icon can stay markup.

**DONE.** The message is set with `textContent`; only the icon is markup. Keep it that way — callers pass `err.message` straight from provider responses.

### A3. Only one `:focus-visible` rule in ~8000 lines of CSS

Keyboard focus is effectively invisible across the app — modals, the floor-plan editor, the tab
bar, card actions. `--tap-min: 44px` exists and is applied to 7 rules, so touch targets were
thought about; keyboard focus was not.

Fix: one global `:focus-visible` outline using the app accent, plus focus trapping in modals
(there is currently none — Tab escapes an open modal into the page behind it).

**Impact: high. Effort: ~half a day including modal focus trapping.**

### A4. Type scale is declared but not used

`--text-lg/md/base/sm/xs` exist (`styles.css:122`). Against that, the stylesheet contains **179
hardcoded `px` font sizes**, and the UI modules contain more inline. Eight declarations sit at
10–11px, below the 12px floor the token comment explicitly calls a floor — including two inside
mobile media queries, where text is already hardest to read.

Fix: mechanical sweep to tokens; treat every sub-12px value as a bug rather than converting it.

**Impact: medium. Effort: ~half a day, low risk, high tedium.** Good candidate to delegate.

### A5. 570 `!important` declarations — *now demonstrably costing time*

The stylesheet fights itself. The root cause is documented in one place (`styles.css:3032` — a
two-`#id` selector that nothing could override without matching its specificity), and that comment
is worth reading before touching any of this: the `#psycle-helper-container` id prefix on nearly
every rule is what forces the escalation.

Fix: not a sweep. Drop the `#psycle-helper-container` prefix in favour of a single class, which
removes the specificity floor that makes `!important` necessary. Large, mechanical, and needs a
browser pass per screen.

**Impact: raised — it is no longer just maintenance.** Between 2026-09-14 and 15 it silently ate three
correct rules: a `display: none` that lost to `.psycle-table td { display: table-cell !important }` (the merged
column then rendered at desktop width alongside the columns it replaces), the Settings submenu indent (equal
specificity, lost on source order), and a button width reset. Each cost a round trip to diagnose.
**Effort: multi-day. Still do not start it until the modular-gyms live acceptance matrix is complete** — it
touches every screen and would invalidate visual acceptance already signed off.

---

## B. Consistency and design-system debt

### B1. Inline styles: 488 `style="` plus 54 `style.cssText` across the UI modules

| Module | `style="` | `.cssText` |
|---|---:|---:|
| `timetable.js` | 172 | 6 |
| `settings.js` | 107 | 21 |
| `credits.js` | 54 | 0 |
| `bookings.js` | 37 | 2 |
| `onboarding.js` | 33 | 0 |
| `autobook.js` | 31 | 9 |
| `tooltips.js` | 26 | 0 |

Already recorded in AGENTS.md as known debt. The concrete cost, now measured: inline styles cannot
be media-queried, which is a direct cause of the mobile-layout item in the modular-gyms backlog.
`timetable.js` and `settings.js` alone are 57% of the total — extracting those two would capture
most of the value.

**Impact: medium. Effort: ~1 day for the two largest modules.**

### B2. Empty states are duplicated markup, not a component

At least four near-identical empty-state blocks are built inline (`bookings.js` ×2,
`autobook.js`, `credits.js`), each with its own padding, font sizes and copy structure. One
`renderEmptyState({ title, hint, action })` in `cards.js` would replace all of them and is the
natural place to add the "Connect a gym" and "no classes match your filters" states consistently.

**Impact: low-medium. Effort: ~2 hours.**

### B3. Modal markup is rebuilt per site

Each module composes its own modal shell, header and close button. There is no shared
`openModal()`. This is why A3's focus trapping has no single place to live.

**Impact: medium (it blocks A3). Effort: ~half a day.**

---

## C. Multi-gym presentation

### C1. Gym colour must stay on gym-scoped elements only

Settled 2026-09-14: `--accent` is Sweat Assistant's and never a gym's. A gym's colour appears only
where it identifies that gym (chip, card rail, row tint, settings card, header badge). The failure
mode to watch for is the opposite of the obvious one — if the whole chrome adopts the active gym's
colour, that colour stops carrying information in a merged list. See the note at the top of the
per-gym theming section in `styles.css`.

Open follow-ups from this:
- **Row tints are 3–3.5% mixes.** Verify they are actually distinguishable on a phone in daylight;
  if not, the gym rail and chip are doing all the work and the tint is decoration.
- **Colour is currently the only gym signal in the timetable table rows.** Colour alone fails for
  colour-blind users and in high-contrast mode. The chip carries a text label, so this is probably
  already satisfied — confirm rather than assume.

### C2. Filter labels collide across gyms — ✅ FIXED 2026-09-15

Location and instructor filter options now group under a gym subheading and get a
`(GymShort)` suffix only when their plain label actually collides with another gym's entry.
See `Backlog/timetable-and-credits.md` T4 for the full writeup, including a related
class-type mislabeling bug (JAB's discipline field) found and fixed in the same pass.

---

## D. Things found while reading, not yet acted on

### D1. The normalized API surface has no rate limiting

`/api/proxy/*` carried 60/min per user. The routes that replaced its callers now carry the same
budget (`routes-normalized.js extrasLimiter`), but the other ~25 normalized routes — timetable,
metadata, bookings, book/cancel/waitlist — have never been limited, because the limiters live in
`server.js` and are applied per route while the normalized routes are mounted as a router.

A blanket limiter would be wrong: an 8-week timetable prefetch legitimately bursts many requests in
a few seconds. This needs a measured read budget separate from the write budget.

**Impact: medium (abuse/runaway-client protection). Effort: ~2 hours plus measuring a real prefetch.**

### D2. Service-worker cache versioning vs. the deploy cache problem

There is a recorded deployment gotcha that three caches must all clear before a fix can be
verified. That is a symptom: if `sw.js` used a build-stamped cache name and cleaned up old
versions on `activate`, two of those three would clear themselves.

**Impact: medium (it costs time on every single deploy). Effort: ~2 hours.** Worth doing before
the next deployment rather than after.

### D3. `client/src/lib.js` still owns Psycle policy

`getNextMondayNoonLondon()` and `detectBookingWindow()` remain in shared client code. Both are
off the correctness path now that the server stamps `releaseAt` per event, but they are one gym's
rules sitting in gym-neutral code, and the server-side equivalents were deleted precisely because
that shape caused a real scheduling failure.

**Impact: low now, high if someone trusts them. Effort: ~2 hours.**

---

## Suggested order

1. **A1 + A2** — an hour, immediately fixes a real exclusion.
2. **D2** — before the next deploy, not after.
3. **B3 then A3** — the shared modal is what makes focus trapping possible.
4. **A4** — delegate; mechanical.
5. **D1** — needs measurement first.

Everything else is genuine debt but is not blocking anyone today. **A5 in particular should not be
started until the modular-gyms live acceptance matrix is complete** — it touches every screen and
would invalidate visual acceptance already signed off.
