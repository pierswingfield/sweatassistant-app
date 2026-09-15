# Two deferred cleanups: `psycle-` naming, and the spot-map editor

Both raised 2026-09-15. Neither is urgent; both are recorded here so they are not
rediscovered as surprises.

---

## 1. `psycle-` is everywhere, and the app is no longer Psycle-specific

### The measurement (2026-09-15)

| Where | Count |
|---|---|
| `#psycle-helper-container` in `styles.css` | **670 occurrences** |
| Distinct `psycle-*` class tokens in `styles.css` | 372 |
| Distinct `psycle-*` tokens in `index.html` | 204 |
| Distinct `psycle-*` tokens in the JS modules | 391 |
| `psycleXxx` localStorage / IndexedDB keys | 12 (`psycleLocalToken`, `psycleTheme`, `psycleCacheEvents`, `psycleOnboarding*`, …) |

The product is **Sweat Assistant**, serving Psycle and JAB with more intended. Almost all
of this markup is app-wide chrome — tabs, modals, toasts, settings, the timetable table —
that has nothing to do with Psycle. The naming now actively misleads: a reader has to
check whether `psycle-membership-card` is Psycle-only (it isn't) or whether
`psycle-gym-chip` is (it isn't either).

### Why it is not a simple find-and-replace

- **`#psycle-helper-container` is an ID**, and 670 rules lean on its specificity. Renaming
  it is safe; **removing** it is not — dropping an id from every selector lowers
  specificity across the whole sheet at once, and the `!important` count (570) exists
  partly because of that id. The two must be untangled together or not at all.
- **The storage keys are persisted user data.** Renaming `psycleLocalToken` logs everyone
  out; renaming `psycleCacheEvents` orphans every cached timetable. Any rename needs a
  read-old/write-new migration, or it is a silent data loss for existing installs.
- **`data-gym` values and provider ids are NOT app naming** — `psycle-london` is a gym id
  and must stay.

### Suggested order

1. **Storage keys last, if at all.** The cost is a migration and the benefit is invisible
   to users. Consider leaving them and documenting why.
2. **CSS + HTML + JS class tokens together, in one mechanical pass**, since a class renamed
   in only two of the three breaks silently and no test covers class names.
3. **`#psycle-helper-container` → a class** is its own project, coupled to the
   `!important` cleanup already logged as §A5 in `ui-ux-sweep.md`. **Do not start it until
   the modular-gyms live acceptance matrix is complete** — it touches every screen.

**Do not attempt this during a feature push.** It produces an enormous diff that hides
real changes in review, and there is no automated coverage of class names to catch a
mistake.

---

## 2. Spot-map editor: row buttons and vertical spacing

### 2a. Whole-row selection is meaningless in some studios

`spotmap.js` shows a `+` per row whenever `editing && rowYs.length > 1`. That is a
geometric test, not a meaningful one: in a studio whose "rows" are an artefact of the
layout coordinates rather than real rows (small PT studios, JAB's Recovery, reformer
rooms), "prefer this whole row" is not a thing a person wants, and the buttons are noise
that also steal horizontal lane width from the map.

Proposal — gate on something real rather than on row count:
- Add a per-gym or per-studio capability, e.g. `layout.rowsAreMeaningful`, defaulting to
  **on** (the unknown-defaults-ON rule: briefly showing a control that isn't useful
  self-corrects; hiding one people rely on does not).
- Failing that, infer: require at least ~4 slots in the row AND at least 3 rows, so a
  2×2 grid stops offering row preferences.
- Whichever is chosen, `rowLaneW` must collapse to 0 when the buttons are hidden, so the
  map reclaims the width.

### 2b. Minimum vertical spacing, and the map overflowing the viewport

Rows can be packed close enough that squares nearly touch, which makes them hard to hit
(and the 26px preference badge overlaps its neighbour). Needed:

- A **minimum vertical gap** between rows, enforced after scaling rather than before, so
  a dense layout expands rather than compresses.
- When the resulting height exceeds the available space, **make the map scroll** inside
  its own container — it must never push the modal's Save button off-screen, which is the
  failure mode that makes an editor feel broken.
- Cap the container at something like `min(60vh, …)` and let the existing pan/scroll
  handle the rest. The "Drag to pan the map" hint already exists for the horizontal case;
  the vertical case should use the same affordance.

Watch for: the editor is rendered inside a modal that is itself height-constrained, so
the height budget has to come from the modal, not from `vh` directly.
