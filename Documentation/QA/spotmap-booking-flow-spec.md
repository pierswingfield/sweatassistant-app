# Spot-map and booking flow: UX spec (mobile, <= 768px)

Builds on `modal-to-fullscreen-spec.md` and `client/src/ui/modal-nav.js` (`openPage`, `pushLayer`, back/X via `data-nav`, history entry per page, dirty guard). Desktop is unchanged. Read-only design; no code was edited.

## 0. What exists today (spot-checked, timetable.js)

- One shell, `#psycle-booking-modal`, three modes in `openBookingModal(event, mode)`: `quickbook`, `autobook`, and `book` (simple "choose seat"). Auto-Upgrade is not a mode; it is a checkbox inside each mode (`#quickbook-auto-upgrade`, `#autobook-auto-upgrade`, `#simplebook-auto-upgrade`).
- The title carries the class details: `quickBookModalTitle` / `autoBookModalTitle` / `chooseSeatFor` format `{studio} {time} {className} with {instructor}` into the header (~3233). Gym and location are not shown.
- `doQuickBook` (~2227) sends a user with NO saved prefs on a map gym into the same modal (`!hasPrefs && hasMap`), where they pick spots on the live occupancy map and the preference is saved as a side effect. Setup and booking are therefore one screen and one mental model, which is the confusion the feedback describes.
- Auto-upgrade checkbox is rendered `disabled` with the copy `autoUpgradeConfigurePrompt` / `autoUpgradeConfigureFirstHtml` ("Please configure your preferred spots...") when no prefs exist (~3617, 3674, 3842). In simple-book mode on mobile, the inline link already opens `openStudioFloorPlanEditor` as a Back-arrow child; the same entry exists in Settings -> Spot maps.
- Studio-level fact: preferences are one map per studio (`studio_preferences`), per user, per gym. Class-level facts: which spots are free right now, quantity, fallback, upgrade.
- `layoutFormat` is per class: FCFS classes have definitively no map (`getStudioMapInfo`); a studio with an unknown layout resolves "has map" (unknown defaults ON).
- Gym branding helpers exist in `cards.js`: `gymBrand(gymId)`, `gymChip`, `gymSquareChip`, `renderGymRail`, plus `trimLocation`, `displayStudioName`. Reuse them; do not invent a logo lookup.

## 1. Principle: two separate things, two separate screens

| | **Step A: Your spots (studio setup)** | **Step B: Book this class** |
|---|---|---|
| Scope | One time, per studio. Reused by Quick-Book, Auto-Book and Auto-Upgrade | Per class |
| Map shown | Studio floor plan, no occupancy | Live occupancy for this class |
| Header identity | Gym logo + location + studio | Gym logo + location (compact) |
| Class details | None (it is not about a class) | Class, instructor, time, shown directly above the map |
| Primary action | "Save my spots" | "Quick-Book" / "Schedule Auto-Book" / "Book" |
| Persisted as | `studio_preferences` | A booking / queue entry / upgrade monitor |

A and B are separate pages in a two-step flow with a stepper. The user must not be able to edit the studio map and a class selection on one canvas.

## 2. Entry conditions and routing

Resolve once on open (reuse `resolveStudioPrefs(event)` + `getStudioMapInfo(event)`; unknown results stay permissive, never "no map"):

| Condition | Quick-Book tap | Auto-Book (queue) | Simple "Choose a spot" |
|---|---|---|---|
| FCFS or no map (`hasMap=false`) | Single-tap book, existing behaviour, no flow | Existing "Schedule any seat" page (see 6) | Existing "Book any" page |
| Map + prefs saved | Skip A: direct quick-book as today (no screen); "Change spots" lives in B | Page B (auto-book form) | Page B (live map) |
| Map + no prefs | **Page A** (intro/setup), then confirmation, then **Page B** | Page A, then B | Page B directly with a non-blocking "set preferred spots" banner (choosing a seat for one class does not require setup) |

Rationale: only the three "automation" intents (Quick-Book, Auto-Book, Auto-Upgrade) depend on stored prefs, so only they gate on A. A one-off "choose a spot" must stay fast.

"Choose a spot for now" opens B with the class map editable. Choices apply to this class only and do not update the saved studio map. "Any spot is fine" in the editor clears saved studio preferences; Quick-Book and Auto-Book can use any available spot, while Auto-Upgrade remains unavailable until preferences are set.

## 3. Screen designs

### 3.1 Shared page header (both steps, replaces class-details-in-title)

```
[<- or X]    Psycle London                [stepper 1 of 2]
             [logo]  Soho  -  Studio 1
```

- Top row: control left or right per the rule in 3.5; title is the static task name ("Set your preferred spots" / "Book your spot"), short and constant so `aria-labelledby` stays meaningful.
- Identity strip directly under the title: `gymSquareChip(gymId)` + gym name + `trimLocation(location)` + `displayStudioName(...)`. Always shown; this answers "which gym am I booking at?" for multi-gym accounts.
- Class details (class name, instructor, time with zone suffix via `formatInZone`) are removed from the header. They appear as the "class card" in B only (3.3).
- Safe-area insets come from the existing `.psycle-page` header rules.

### 3.2 Step A: "Set your preferred spots" (studio setup)

**A0 intro (first time only, no prefs, map gym).** Full-height page, content y-centred in the body (`justify-content:center; min-height:100%` on the body inner wrapper, falling back to top-aligned when content exceeds the viewport so it never clips). Uses the extra vertical space the feedback asks for:

- Large gym logo (`gymBrand` mark, ~72px) with the location line beneath.
- Illustration: a small static preview of the studio map with 2-3 numbered spots (no live data).
- Headline + 3 short value lines + one reassurance line (copy in section 7).
- Footer (sticky): primary "Choose my spots". In a class flow only, secondary text "Choose a spot for now" opens B without saving studio preferences; onboarding and Settings show no class-only action.
- No scrolling expected at 390x844; at 667px height the body scrolls and the footer stays pinned.

**A1 editor.** Same page, body swaps to the studio floor-plan editor (`renderStudioFloorPlan` with `onSave`, the editor `openStudioFloorPlanEditor` already provides). A0 -> A1 is in-page (pushes a history entry so Back returns to the intro, not the timetable).

- Dismissible helper above the map: a card with a one-line instruction and an X (see 3.4).
- Selection counter chip: "3 spots chosen (in order of preference)". Rows can be toggled as whole-row preferences, as today.
- Footer: primary "Save my spots" (disabled with an inline reason when 0 selected: "Pick at least one spot, or choose 'Any spot'"), secondary "Any spot is fine". This clears saved studio preferences and proceeds without them: Quick-Book/Auto-Book can use any available spot; Auto-Upgrade still requires saved preferences. The user can choose a class-specific spot on B without changing the studio map.

**A2 saved confirmation (transition screen, not a toast).** After a successful save, show a full-page success state for ~1 interaction (no auto-advance timer, to respect screen readers and user pace):

- Checkmark, "Your spots are saved", "Next time, Quick-Book and Auto-Book will go straight for these spots at {Studio}."
- Primary "Continue to book {Class}" (advances to B; replaces the A page rather than stacking, see 5), secondary "Edit spots" (back to A1).
- When Step A was opened from Settings (no class context), the primary is "Done" and closes with X semantics.

### 3.3 Step B: "Book your spot" (class-specific)

Top to bottom:

1. Header + identity strip (3.1).
2. **Class card** (new, directly above the map): class name, instructor (avatar via the existing `instructorAvatar(name, gymId, directUrl)`), time, spots left. This is the visual and semantic divider: everything below it is "this class".
3. Mode-specific controls row: quantity (1-4) and "fallback to any spot" (existing controls, regrouped under the map in a compact "How should we book?" group).
4. **Live occupancy map** (read-only occupancy, tap to choose for a one-off, or for Auto-Book/Quick-Book your saved preference is pre-highlighted).
   - Pre-highlighted preferred spots are shown as numbered badges (1, 2, 3...), a legend line "Your preferred spots", and a "Change preferred spots" link that opens A1 as a child (Back arrow). This is the only place the studio-level concept intrudes, and it is labelled as such.
   - Dismissible helper above the map (3.4).
5. Auto-Upgrade control (4.3).
6. Sticky footer primary action, mode-specific label; credit warnings (`creditWarning`) render above the footer, not inside scrolling content.

### 3.4 Helper copy above the map (both steps)

- One card per page type, dismissible with an X (min 44px hit area, `aria-label="Dismiss tip"`). Dismissal persists per helper id in `localStorage` (`psycleHelperDismissed:{helperId}`) wrapped in try/catch. A "Show tip" affordance is not required; users can re-read it in Settings -> Help (out of scope), so keep the helper to one line when dismissed state is lost.
- Two ids: `spotmap-setup` (Step A editor) and `spotmap-live` (Step B). They are independent.
- Never block interaction; never overlays the map (it sits in normal flow above it, pushing the map down by <= 64px).
- When dismissed, the map gets that vertical space back (no collapsed placeholder).

### 3.5 Back vs X semantics at each step

| Page | Control | Result |
|---|---|---|
| A0 intro (entered from timetable) | **Back** | Return to the timetable. No unsaved state. |
| A1 editor (entered from A0) | **Back** | Return to A0. If selection is dirty: discard guard ("Discard your spot choices?"). |
| A1 editor (entered directly from Settings or from B's "Change preferred spots") | **Back** if opened from B (child), **X** if opened as the top-level task from Settings | Back returns to B with the booking state intact. |
| A2 saved confirmation | **X** | Close the whole flow (the work is done and persisted; this is a terminal screen). Primary button continues. |
| B (top-level, entered after A or directly) | **X** | Close flow; the guard runs if the user changed quantity/spot choices (the dirty-state set in 5). |
| B opened from A2 "Continue" | **Back** | Return to the saved confirmation. Continue again or edit the map; X on A2 returns to the timetable. |

General rule from the previous spec holds: X when you land on the tab, Back when you land on another page that belongs to the same task.

## 4. Mode differences

### 4.1 Quick-Book
- Intent: book NOW using saved prefs. If prefs exist it never shows a page (current behaviour kept): this is the point of "quick". With no prefs it enters A, then B.
- B differences: footer "Quick-Book {n} spot(s)"; quantity and fallback visible; live availability decides which preferred spot is taken (existing slot-picking logic). If none of the preferred spots is free: fallback toggle decides (any spot vs "no spot, join waitlist" per existing logic).
- Success: haptic + toast + close with X semantics (existing).

### 4.2 Auto-Book
- Intent: queue a booking for a class that is not yet open (release instant per `releaseAt`). Spots chosen are preferences, not reservations; live occupancy is not meaningful before release.
- Step B variant: the "live occupancy" map is the studio map (no occupancy), with a pre-highlighted preference and a note "Spots are chosen when booking opens at {releaseTime}". The class card shows release time and "Opens in {countdown}" using `releaseAt`.
- Footer: "Schedule Auto-Book". Warnings from the overlap flow (`warnings[]`, `DUPLICATE_AUTO_BOOK`) are handled as today by the overlap dialog/layer.
- Auto-Upgrade checkbox here means "keep looking for a better spot after booking" (`autoUpgradeKeepSearchingLabel`).

### 4.3 Auto-Upgrade (checkbox in B, never a mode)
- Replaces the permanently disabled checkbox. Three states:
  1. **Prefs saved** (the normal case after Step A): enabled, label "Keep looking for a better spot" with the sub-line "We will move you to a spot higher on your list if one opens (until 12h before class)". Default follows `gymSetting(gymId, 'autoUpgradeByDefault')`.
  2. **No prefs and user skipped**: not disabled-and-silent; render a row "Auto-Upgrade needs your preferred spots" with a button "Set up spots" that opens A1 as a Back child (4.4). After saving, the row becomes enabled state 1 live (the existing `updateSimpleBookControls` callback pattern: `hasExistingPrefs` is set from the saved slots, not from a refetch that races the cache).
  3. **No map (FCFS)**: row hidden (unchanged: `!hasLayout` returns '').
- The checkbox is never `disabled` without a visible, tappable way to fix it.
- Auto-Upgrade also needs a credit headroom (`availableCredits + 1`, ~3304): keep the existing warning but place it directly under the checkbox.

### 4.4 Simple "Choose a spot" (mode `book`)
- No A gate. Banner above the map (only when no prefs on a map gym): "Save your preferred spots to Quick-Book next time" with button "Set up spots" (opens A as a Back child). Dismissible with the helper X pattern, same persistence.

## 5. State, history and unsaved-work handling

- Flow state object kept in `timetable.js` module scope for the flow lifetime: `{ eventId, gymId, mode, step: 'A0'|'A1'|'A2'|'B', draftSlots, draftRows, qty, fallback, upgrade }`. It is cleared on terminal close. Because B is not unmounted when A1 opens from it (child page), `qty/fallback/upgrade` survive a trip to A1 with no re-render hacks.
- History entries (via `openPage` / `pushLayer` in `modal-nav.js`):
  - Timetable -> A0 (entry 1), A0 -> A1 (entry 2), A1 save -> A2 replaces the A1 layer, and A2 Continue pushes B as a child page. Back from B returns to A2; closing A2 returns to the timetable.
  - Direct entry to B (prefs exist): B is entry 1. "Change preferred spots" from B pushes A1 (entry 2); Back or save pops it.
  - If the helper currently lacks a "replace" operation (it has push and close), add one (`replacePage(el, id)`) or emulate it by close-with-force + open without animation; this is a helper API gap to confirm during implementation.
- Dirty state:
  - A1: selection differs from the saved prefs or from the empty set when first-time. Guard on Back/X/hardware back. Save clears dirty.
  - B: dirty if quantity, fallback, upgrade or manual spot choice differ from the initial defaults. A nice-to-have, since no data is lost on dismiss; use the guard only for the manual spot choice and quantity > 1 (cheap to recreate otherwise).
  - A2: never dirty.
- Interrupted save: if `PUT /api/studio-preferences/:id` fails (network/error), stay on A1, keep the selection, show an inline error banner above the footer ("Couldn't save your spots. Check your connection and try again.") with a Retry on the primary button. Do not advance to A2.
- Offline: A1 Save disabled with "You're offline" (existing `psycle-offline` class convention); B actions disabled likewise.
- Gym session `needs_relogin` (link flagged): B shows an inline notice "Reconnect {Gym} to book" with a button to the gym link page; footer disabled.

## 6. Gyms and classes without a map (FCFS / no layout)

- Quick-Book: single tap books any spot (existing). Never routes to A or B.
- Auto-Book: one compact page (no stepper, no A): identity strip, class card, short explanation "This class has no assigned spots, so we will book you in as soon as it opens", qty control, footer "Schedule Auto-Book". Reuses the current `noFloorMap` branch visually upgraded to the same header and class card.
- Simple book: "Book" with no map: same compact page, footer "Book {noun}".
- Auto-Upgrade row hidden (4.3). Settings -> Spot maps lists only studios that have a map.
- Unknown layout (studio missing from the studio list): treat as has-map until the layout fetch resolves; if the fetch returns empty slots, fall back to this compact path without an error toast.

## 7. Copy drafts (British English; style: short, active, no exclamation marks)

Step A0 intro:
- Eyebrow: `Set up once per studio`
- Headline: `Tell us where you like to work out`
- Body lines:
  - `Pick your favourite spots at {Studio}, in order of preference.`
  - `We use them every time you Quick-Book, Auto-Book or Auto-Upgrade.`
  - `Change them whenever you like in Settings.`
- Reassurance: `Nothing is booked yet. This takes about 20 seconds.`
- Primary: `Choose my spots` / Secondary in a class flow: `Choose a spot for now`

Step A1 editor helper (dismissible): `Tap studio spots in the order you prefer them. Choose as many as you like!` Add `You can also choose entire rows with the + button, but individual spots will be most preferred when booking.` only when row preferences are enabled for that studio.
- Counter: `{n} spot(s) chosen`; zero state: `No spots chosen yet`
- Primary: `Save my spots`; alt: `Any spot is fine`
- Disabled reason: `Pick at least one spot, or choose "Any spot is fine".`
- Discard dialog: Title `Discard your spots?` Body `You haven't saved your changes.` Buttons `Keep editing` / `Discard`

Step A2 confirmation:
- Title: `Your spots are saved`
- Body: `Next time, Quick-Book and Auto-Book will go for these spots at {Studio} first.`
- Primary: `Continue to book {Class}` (from a class) / `Done` (from Settings); secondary: `Edit spots`

Step B:
- Header title: `Book your spot` (Quick-Book/Book) / `Schedule Auto-Book` (Auto-Book)
- Class card label: `This class`
- Map helper (live, dismissible): `Your preferred spots are numbered. Tap any free spot to choose a different one just for this class.`
- Map helper (auto-book): `Spots are picked the moment booking opens at {time}. Your numbered spots go first.`
- Preferred-spots link: `Change preferred spots`
- Fallback: `If my spots are taken, book any spot`
- Auto-Upgrade label: `Keep looking for a better spot`; sub: `We'll move you to a higher-ranked spot if one frees up, until 12 hours before class.`
- Auto-Upgrade no-prefs state: `Auto-Upgrade needs your preferred spots` + button `Set up spots`
- Auto-Upgrade credit note: `Auto-Upgrade needs one spare credit while it swaps.`
- Primary labels: `Quick-Book {n} spot(s)` / `Schedule Auto-Book` / `Book {noun}`

Empty / error states:
- Map failed to load: `We couldn't load the floor plan.` `Try again` / `Book any spot` (when allowed).
- Class full: `This class is full.` `Join waitlist` (existing `fullyBookedJoining` flow).
- No eligible spots: reuse `noEligibleSlots`: `None of your spots are free.` plus the fallback-toggle reminder.
- Save failed (A1): see section 5.
- Offline: `You're offline. Reconnect to book.`

## 8. Stepper / progress cue

- Shown only when the flow includes A (first-time, map gym). A two-segment indicator under the identity strip: `1 Your spots   2 Book class`. Segment states: current (accent), complete (check), upcoming (muted). Text, not colour alone (`aria-current="step"`, `aria-label="Step 1 of 2: Your spots"`).
- Hidden when B is entered directly (prefs exist) and on compact FCFS pages (a one-step task needs no stepper).
- On A2 the stepper shows 1 complete, 2 current-next. Keeps height <= 36px so the map keeps its space.

## 9. Implementation notes (no code changes made)

- Files: `client/src/ui/timetable.js` (`openBookingModal` modes, `doQuickBook` routing, `autoUpgradeConfigure*` checkbox blocks at ~3617/3674/3842, title formatting ~3233), `client/src/ui/settings.js` (`openStudioFloorPlanEditor` ~938, reuse for A1; add intro/confirmation wrapper), `client/src/ui/spotmap.js` (map unchanged; helper card slot above it), `client/src/ui/autobook.js` (edit-entry reuses the shell, ~531), `client/src/ui/bookings.js` (edit-spots/upgrade configure share the shell; header identity strip applies, Step A does not), `client/src/ui/cards.js` (`gymSquareChip` reuse, possible `gymIdentityStrip()` helper), `client/src/ui/modal-nav.js` (add `replacePage` if needed), `client/src/copy.js` (new strings; remove or repurpose `autoUpgradeConfigurePrompt` / `autoUpgradeConfigureFirstHtml`), `client/src/styles.css` (identity strip, class card, stepper, helper card, A0 centring; after the base modal rules, `!important` where fighting inline styles), plus tests: `quickbook-flow.test.js` (routing matrix in section 2), `modal-nav.test.js` (replace semantics), new `spotmap-flow.test.js` (state object).
- AGENTS.md invariants to respect: ids are strings (`sameId`/`String()`); one lookup per fact (`resolveStudioPrefs` is the only prefs lookup); unknown capability/layout defaults ON; `layoutFormat` is per class; `hasExistingPrefs` after save comes from the saved payload, not a refetch; credit arithmetic only via `credit-allowance.js`.
- Desktop: `isMobile()` gate keeps the current modal and checkbox behaviour; only the copy for the disabled-checkbox state may be improved globally (low risk).
- Do not run real bookings in verification (live-testing authorisation); use the dev mock accounts (`dev@psycle.com`, `dev@jabboxing.mock`) and stop before the booking POST on live gyms.

## 10. Rollout: 3 batches

Real-browser verification at 390x844 (Chrome CDP :9222 or Claude for Chrome, one tab), dev mock, plus 1100px desktop regression; evidence under `QA/browser-runs/`.

**Batch 1: Header identity + class card + helper (Step B restructure, no new steps).**
Changes: identity strip in all booking-shell modes; class details moved from title to class card above the map; dismissible helper with persistence; sticky footer primary; checkbox row restyled (still gated as today).
Acceptance at 390px:
- Header shows gym logo, gym name and location in all four entry points (timetable book, Quick-Book setup, Auto-Book edit, Auto-Upgrade configure); the `<h4>` title contains NO class/time/instructor text (assert by text content).
- Class card (class, instructor, time with zone suffix when it differs from the device) sits immediately above the map: `classCard.bottom <= map.top + 24`.
- Helper X hides the helper, the map moves up by the helper's height, and the dismissal persists across a reload (`localStorage` key present); a failed `localStorage` does not break the page.
- Footer button visible without scrolling, above the safe-area inset; no horizontal overflow; desktop at 1100px unchanged.

**Batch 2: Step A flow (intro, editor, confirmation) + routing + Auto-Upgrade states.**
Changes: routing matrix (section 2); A0 intro (y-centred), A1 editor reuse, A2 confirmation; `replacePage`; stepper; dirty guards; Auto-Upgrade three states; skip option; save-failure state.
Acceptance (mock account with no saved prefs on a map gym, then with prefs):
- No prefs: tapping Quick-Book opens A0. Body content is vertically centred (content block top and bottom margins within 24px of each other when it fits); logo + location visible; primary and Skip visible without scrolling at 844px height.
- "Choose my spots" -> A1; Back returns to A0; select 2 spots + "Save my spots" -> A2 ("Your spots are saved") -> "Continue" -> B with those 2 spots pre-highlighted and numbered; Auto-Upgrade checkbox is enabled (not `disabled`).
- Browser Back from B closes the flow and lands on the timetable (history length delta 0; A steps are not in the stack).
- Skip -> B shows the Auto-Upgrade row "needs your preferred spots" with a "Set up spots" button; tapping it opens A1 with Back; saving returns to B with the checkbox enabled, qty/fallback unchanged.
- Dirty A1 + Back shows "Discard your spots?"; Keep editing stays; Discard leaves with prefs unchanged. Force a failed save (block the request in devtools): error banner shown, stays on A1, selection kept.
- With prefs saved, Quick-Book on the same class books without opening any page (existing behaviour intact).

**Batch 3: Mode variants, FCFS/no-map, polish.**
Changes: Auto-Book variant copy and release countdown; simple-book banner; compact FCFS pages; offline/relogin/error states; stepper polish; copy audit; tests.
Acceptance:
- Auto-Book on a map gym: map shows the studio layout (no occupancy), copy "Spots are picked the moment booking opens at {time}", release countdown present; queue entry created in the mock (verify in `GET /api/auto-book`).
- FCFS class (JAB mock): Quick-Book is single tap and opens no page; Auto-Book opens the compact page with no stepper and no Auto-Upgrade row; no console errors.
- Simple "Choose a spot" with no prefs: banner visible and dismissible; opening "Set up spots" from it works as a Back child and returns with the live selection intact.
- Offline emulation: primary buttons disabled with the inline reason; relogin-flagged gym shows the reconnect notice.
- Rapid open/close x5: no orphaned overlays or history entries; screen-reader attributes present (`aria-current="step"` on the stepper, helper close `aria-label`); `npm test` green.

## 11. Open decisions

1. Should "Skip for now" persist per studio (stop re-offering setup) or re-offer once per session as specified?
2. Auto-Upgrade default-on when prefs exist: keep `autoUpgradeByDefault` as is, or default on right after Step A (a user who just set spots is likely to want it)?
3. Does Step A also appear for the simple "Choose a spot" path? Spec says no (banner only); confirm.
4. Settings entry: add a "Spot maps" shortcut link from A2/B so users can find this later (copy references "Settings"); confirm that Settings -> Spot maps is visible to non-debug users (the audit says it is hidden in non-debug mode).
5. `modal-nav.js` replace-semantics: add `replacePage` or accept one extra history entry for A2.
