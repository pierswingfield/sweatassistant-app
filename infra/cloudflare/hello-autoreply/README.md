# hello-autoreply

Cloudflare Email Worker that auto-replies to mail sent to hello@dibs.fit and hello@mail.dibs.fit, then drops it. The reply's From is the address that received the mail (Cloudflare only allows replying from the receiving address; a hello@dibs.fit reply from the mail. subdomain is rejected). App mail sets Reply-To hello@dibs.fit.
Skips automated mail (Auto-Submitted, Precedence bulk/list/junk, List-Id/List-Unsubscribe,
mailer-daemon/postmaster/noreply senders, and anything from mail.dibs.fit itself).

- Deploy: on oracle, from a copy of this folder with wrangler installed: `CLOUDFLARE_API_TOKEN=<cf OAuth token from ~/.config/cloudflare/config/default.json> npx wrangler deploy` (never print the token).
- Routing: Email Routing enabled for subdomain `mail.dibs.fit` (adds 3 MX + 1 SPF TXT on mail.dibs.fit only);
  rule `hello@mail.dibs.fit` (id 0661cd214c2742c3880258a154934528) and apex rule `hello@dibs.fit` (id a9613383057843e591459d7fb62aeb3d, apex Email Routing already on for privacy@dibs.fit, no DNS change) -> Worker `hello-autoreply`.
- Remove: `cf email-routing rules delete a9613383057843e591459d7fb62aeb3d -z dibs.fit` (apex rule); to remove everything also delete the mail. rule, `cf workers delete hello-autoreply`, optionally remove the
  mail.dibs.fit MX/SPF records Cloudflare added. Do not touch send.mail / resend._domainkey (Resend).
- No secrets are used.
