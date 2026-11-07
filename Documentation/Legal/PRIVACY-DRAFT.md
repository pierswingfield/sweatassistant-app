# Dibs privacy notice — draft

**Draft 7 November 2026. Unpublished; resolve placeholders and review notes first.**

## Who is responsible

**[operator's full legal name and status]**, **[contact/service address]**, is the individual controller operating under the trading name **Dibs** in the United Kingdom at dibs.fit and app.dibs.fit. Privacy contact: **privacy@dibs.fit**. This notice covers Dibs; gyms and services you use separately have their own notices.

## What we collect and why

| Information | Purpose and proposed UK GDPR basis |
|---|---|
| Dibs email, password hash, name and account/settings records | Create and secure your account and provide the service you request: contract. |
| Linked gym email, encrypted password and sessions; provider profile, membership/credit and class information | Connect to your chosen gym, show your account and bookings, keep history and run enabled booking/sync features: contract. |
| Bookings, waitlists, class history, favourite classes/spots, automation instructions and outcomes | Provide your timetable, booking assistance, reminders and activity views: contract. These records come from you and linked gym/provider APIs. |
| Team memberships and sharing choices; information you choose to share | Provide optional Team features you request: contract. You control participation and per-Team visibility.  |
| Push subscription/device routing details and calendar tokens | Deliver optional notifications and private calendar feeds you request: contract; browser permission is also required for push. |
| Technical/security logs, request metadata and support messages | Protect accounts, investigate faults and respond to support: legitimate interests in running a secure, reliable service. Legal obligations apply where retention/disclosure is required by law. |
| Landing visits/clicks, page/referrer host, broad device/country and campaign information | Understand use of the landing page: proposed legitimate interests in improving it, subject to the tracking-law review below. |

Account credentials enable sign-in; gym access details enable a connection. Other features are optional. Without necessary information we cannot provide that feature. Dibs sign-in is separate from gym sign-in.

## Credentials and access

Your Dibs password is a salted scrypt hash. Gym passwords and provider sessions use AES-256-GCM encryption with a server key outside the database. **The server can decrypt them** to renew access and run background features. The operator can access account information; control of the server and key permits decryption. Other database information is not necessarily encrypted.

The public service uses HTTPS. Security cannot eliminate breach risk. Never send passwords in support messages.

## Who receives information

We send relevant credentials, sessions and requests to the gyms/providers you connect. Their rules govern their own processing. Hosting, network delivery/security and backup providers process information for operating Dibs: **[confirm Oracle hosting region, Cloudflare services, Google Drive encrypted backup arrangement, other providers and contracts]**. Browser push services route enabled notifications. Calendar providers receive the contents of feeds you subscribe to. Checkout is handled through the relevant gym/provider payment flow; **[confirm the final card-data flow before describing payment handling]**.

Team members see information allowed by your sharing settings. The joining screen initially selects gyms, upcoming classes, waitlists, activity and recent classes; spots, Auto-Book queue and competition start off. Review these choices. Counts may remain visible when class details are hidden. Sharing reveals times/locations. Changing settings cannot recall screenshots or exports.

Anyone with a private calendar URL can read its feed. Keep it secret and regenerate it if exposed. We may disclose necessary information for legal obligations or claims.

**International processing:** [List actual destinations and applicable UK adequacy decisions or safeguards, and how users can obtain details. Do not publish a general assurance until the provider/transfer assessment is complete.]

## Device storage and landing analytics

Local storage holds sign-in/preferences, IndexedDB caches account data, and service-worker caches support offline operation. Uninstalling does not delete your server account.

Landing analytics do not set an analytics cookie. The server derives a daily-changing identifier from the IP address, user agent and secret; the analytics table stores that identifier rather than the raw IP or user agent. This is pseudonymous, not guaranteed anonymous. Network/security providers may separately process IP addresses. **[Complete tracking-law assessment and any required notice/objection control before publication; “cookieless” alone does not establish exemption.]**

## Retention and choices

Account and class-history records remain while your account/gym connection needs them. The 30-day Team recent-class view limits visibility, not storage. Unlinking deletes that gym's credentials, sessions and gym-scoped data from the live database. Settings also offers account deletion. This does not cancel gym bookings or delete provider-held records. Landing events are scheduled for deletion after 13 months.

**[Confirm and insert actual account inactivity, log/support and backup retention periods and any justified exceptions.]** The backup script defaults to 14 days locally/30 remotely; confirm deployed jobs and other snapshots. Deleted information may remain in isolated backups until expiry; any restore must reapply deletions. Restrict retained records to recovery or justified legal needs.

## Your rights and contact

You can request access, correction, deletion, restriction and portability, subject to applicable conditions. **You can object to processing based on legitimate interests**, including landing analytics; contact **privacy@dibs.fit**. Any consent can be withdrawn without affecting earlier lawful use. You can disable optional features, change Team sharing, revoke browser push permission and regenerate calendar links.

Automation follows your booking instructions and may affect gym credits or charges; you can remove queued instructions and check outcomes with the gym. It is not a guarantee of acceptance by the gym.

Contact us about concerns or rights. You can complain to the [Information Commissioner's Office](https://ico.org.uk/make-a-complaint/). We will date updates and explain material changes before new uses begin.
