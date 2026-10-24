# M — Dibs landing page (spec)

**Status:** live at `dibs.wingfield.tech`. Renamed from "Front Row" to "Dibs" on 2026-10-24 (landing only: droplet mascot header, run-in video that slides in from the left, pushes the headline right and freezes on its last frame; the old Front Row subdomain was removed 2026-10-24). Built 2026-10-23. Specified 2026-10-23. Step 3 (server-side analytics: `server/landing-events.js`, `/_a/pv`, `/_a/go`, `GET /api/admin/landing-stats`, `server/test-landing-events.js`) built 2026-10-23, not deployed; landing page built. Decisions below were settled in a grilling session with the user. Deploying anything to the public internet needs a separate explicit go-ahead.

## Outcome

A public, glassy, animated marketing page that presents the app as a **concierge for people who organise their fitness life across gyms**, with one CTA: install the PWA at `https://sweat.wingfield.tech`.

## Decisions

| # | Decision |
|---|---|
| M-D1 | **Name: "Dibs"** (landing page only; was "Front Row" until 2026-10-24, see `M-name-check.md`, whose research is about the old name). The in-app name stays "Sweat Assistant" (`APP_NAME`); a full rename is a separate decision. Run domain, app-store and trademark availability checks for "Dibs" (not yet done). |
| M-D2 | **Host:** separate static site on `dibs.wingfield.tech` (moved from the retired Front Row host on 2026-10-24). Own folder `landing/` in this repo, tiny nginx container on oracle behind the existing Cloudflare tunnel, own `deploy-landing.sh` mirroring `deploy.sh`. Zero coupling to the SPA, its routes (`/` is the SPA, PWA `start_url` is `/`) or the service worker. |
| M-D3 | **Audience and hook:** public gym-goers. Headline "Your fitness life, handled." / hero line "Be first in the room." Auto-book is the proof point, not the whole story. Calm, premium, warm tone, no hype. |
| M-D4 | **Brands:** show the Psycle, JAB Boxing and AARMY **logos** in a "Works with" strip (copy assets from `client/public/gyms` into `landing/`, never hotlink) with a footer disclaimer: unofficial, not affiliated with or endorsed by any gym. |
| M-D5 | **Product visuals:** coded, sanitised mock UI built from the app's own tokens with fake data; no screenshots. |
| M-D6 | **Theme:** light only. Warm `#f5f2ec` ground, frosted white glass panels (backdrop blur, hairline borders), drifting clay and slate-blue light blobs. Fraunces headings, Inter body, 12px type floor. Tokens defined once on `:root`; no glows on buttons (DESIGN.md anti-patterns). |
| M-D7 | **Build:** one dependency-free `index.html`, inline CSS and vanilla JS, Google Fonts only, no framework, no build step. |
| M-D8 | **CTA:** primary "Get the app" to `https://sweat.wingfield.tech`, in the sticky nav, hero, install section and footer. Quiet secondary "Already a member? Open the app" link to the same URL. Platform-aware install hint: iOS Safari shows "Share, then Add to Home Screen"; Android and desktop show the browser install path. |

## Sections (in order)

1. Sticky glass nav with CTA.
2. Hero: headline, subline, CTA, animated glass timetable card and countdown.
3. "Works with" logo strip.
4. Three feature scenes, each animated: **Auto-Book** (countdown to 12:00:00, then "Booked ✓"), **Auto-Upgrade** (seat map where the preferred spot lights up), **One timetable** (classes from several gyms merging into one list).
5. "Stays out of your way": push alerts, calendar feed, credit warnings, favourites.
6. Trust: credentials encrypted at rest (AES-256-GCM), no gym affiliation, unlink a gym or delete the account at any time. Claim nothing that cannot be verified in the code (no "bank-grade").
7. Install: three frames for Add to Home Screen.
8. Final CTA and footer with disclaimer.

Subline: "A concierge for every gym you train at: it books the classes you want, the second they open, in the spot you like, and keeps it all in one calendar."

## Animation

- Slow drifting blob background.
- Staggered scroll-reveal: 24px rise plus fade, spring easing `cubic-bezier(0.25, 1, 0.5, 1)`, 0.2 to 0.35s. No bounce, elastic or overshoot.
- Subtle pointer-parallax tilt on hero cards.
- Three looping scene animations (above).
- CSS plus about 60 lines of vanilla JS (IntersectionObserver). Everything static under `prefers-reduced-motion`.

## Server-side analytics

- **Collection:** the landing nginx proxies `/_a/*` to the app server over the `edge` Docker network (same origin, no CORS, no third-party scripts). Page views are recorded by that proxied request, so they work with JS disabled. The CTA is a `/_a/go` 302 redirect to the app that counts the click server-side.
- **Storage:** new SQLite table `landing_events`, written only through one module (same pattern as `class-history.js`).
- **Privacy:** no cookies, no client-side IDs, no consent banner. A visitor is a daily-rotating hash of IP, user agent and a server secret; the IP is never stored. Stored per event: timestamp, type, path, referrer host only, country (Cloudflare `CF-IPCountry` if present), device class, UTM campaign. Retention 13 months with a nightly purge.
- **Events and metrics (v1):** page view, CTA click (tagged hero/nav/install/footer), open-app click. Daily unique visitors, views, CTA click-through rate, top referrers and UTMs, device split, country. No scroll or section metrics in v1 (would need a client beacon).
- **Bots:** simple user-agent rules set a bot flag; rows are flagged, never dropped, so counts stay auditable.
- **Abuse:** rate limit `/_a/*` (public write endpoint).
- **Admin:** in scope now is one admin-JWT-gated `GET /api/admin/landing-stats?days=`. The admin SPA tab is later.

## Out of scope

Privacy and terms pages (gap to file in BACKLOG.md), full app rename, scroll-depth analytics, admin SPA tab, dark theme.

## Acceptance

- Verified in the user's real Chrome (Claude for Chrome or CDP 9222) at mobile and desktop widths, per [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).
- Animations stop under `prefers-reduced-motion`.
- Server test covers event recording, visitor-hash rotation, the click redirect, rate limiting and the admin stats endpoint.
- No raw hex or `rgba()` outside the `:root` token block; every heading uses the serif stack.
- Nothing deployed without an explicit go-ahead.
