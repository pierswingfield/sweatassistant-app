# Barry's attendance dev deployment — 2026-10-30

- Application commit deployed: `505cdf2b86b6d40e7ea73607e4c42ac6883fdf4b`.
- Target: `sweat-dev.wingfield.tech` / `sweatassistant-dev`; production was not deployed.
- `HOMERUN_ENABLED=true` and `BARRYS_UK_ENABLED=true` were added to the dev `.env`. Existing JAB Boxing and Aarmy flags were preserved.
- Before enabling the gyms, read-only database counts showed no linked accounts and no auto-booking or auto-upgrade rows for either gym.
- Tailnet `/api/health` returned `status: ok`; the container is running with restart count 0 on Node `v22.23.4`. Real Chrome loaded `assets/index-CJ2Jg4q-.js`; public `/api/gyms` reports Barry's enabled with `attendanceTotals: true` and Homerun enabled.
- The Home before/after screenshots use the isolated dev mock and temporary database. The Home after-state showed 612 Barry's classes beside the unchanged 338 and 129 totals. No live gym request or write was made.
- Pre-deploy SQLite backup present: `/var/backups/sweatassistant-sqlite/dev/sweatassistant-20261030-041001.db.gz`.
- Rollback application commit: `b7d51d4` (previous master). It ignores the two new flags.
