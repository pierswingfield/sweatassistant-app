# Node2Shell runtime remediation

**Status:** implementation prepared locally on 2026-10-24; no environment has
been deployed or recreated by this change.

Sweat Assistant's build and runtime are pinned to `node:22.23.4-bookworm-slim`
in both Docker stages. Node 22.23.4 is the minimum approved runtime for this
repository: do not substitute `node:22`, `latest`, or an unpinned distribution
tag.

Local development and verification use the matching `.nvmrc` value. Run
`nvm use` before `npm ci`, `npm test`, or `npm run build:client`.

Before a separately authorised deployment, the release owner must:

1. start from a clean, reviewed commit in a dedicated release worktree;
2. build the image from the committed Dockerfile and record its immutable image
   digest for rollback;
3. verify `node --version` in the new image/container is `v22.23.4` or a later
   explicitly approved patched Node 22 release;
4. run `docker compose config`, the full test suite, and the production client
   build before recreation; and
5. keep the existing Cloudflare WAF mitigation enabled while completing the
   normal health and authenticated smoke checks.

This file deliberately contains no deployment command: a deployment needs its
own explicit authorisation and must follow `deploy.sh` safeguards.
