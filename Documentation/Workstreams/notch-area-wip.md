# Notch area (iOS 26+ safe-area cover): WIP, parked

Branch: `wip/notch-area` (local only, never deployed, not on master).

## What is enabled here
- `client/index.html`: an inline script switches `apple-mobile-web-app-status-bar-style` to `black-translucent` when Safari reports `Version/26` or later. Older iOS keeps `default`.
- `client/src/safe-area.js` sets `html.sa-cover` when standalone and `env(safe-area-inset-top)` is above 0. The `html.sa-cover` rules in `styles.css` (`--sa-edge` 16px, `--sa-edge-bar` 32px, `--hdr-hide-d`, the `body::before` band, header and modal top padding) were never removed, so they apply as soon as the style is captured.
- `client/src/scroll-reset.js` is kept (resets window scroll, guards stale scroll).

## Real-device regression
On a real iOS 26+ iPhone the app opened with a black gap, content shifted up about 62pt (the inset) and the header hidden under the notch.

Suspected cause: an `html.sa-cover::before` block of `100lvh + 1px`, added so iOS would size the black-translucent window to the full screen (the Simulator gave 812 of 874pt without it). It made the document overflow, so the window opened already scrolled by the inset. That trick was removed in the fallback (see the comment in `styles.css` near "Removed 2026-11-17"). It was never committed as code, so it is NOT restored here; this branch runs without it and may show the short window (dead strip at the bottom) seen in the Simulator.

## Constraint: status bar style is fixed at install
iOS reads the style once, when the app is added to the Home Screen (WebKit 260508). Changing the meta and relaunching changes nothing. Every test needs: delete the home-screen app, reload the site in Safari, Add to Home Screen again (this also clears login, storage and push).

## What to try next
- Never let the document overflow the window. No `lvh + 1px` block.
- Size full-height roots with fixed insets (`position: fixed; inset: 0`, `height: auto`) and pad by `env(safe-area-inset-top)` and `--sa-edge`, rather than `100dvh` or `100lvh`.
- Check `innerHeight`, `scrollY` and `visualViewport` on launch against `screen.height` to see where the missing 62pt goes.
- Keep `scroll-reset.js` as a backstop, not the fix.

## How to test
- Simulator: the `ios-pwa` tools (`capture_pwa_screenshot`, `audit_pwa_layout`, `evaluate_js`) on an iOS 26+ runtime; remove and re-add the app between style changes. The Simulator under-reported the problem (it showed a short window, not the scrolled one), so it is not sufficient.
- Real device: deploy to the dev twin only, remove and re-add the app, then check the first launch and a cold relaunch.
