# Backlog Spec: In-App 3-D Secure Support

## Context & Problem
In-app credit checkout is currently server-driven via the BFF proxy (`POST /api/cart/checkout/init/:bundleId` → `POST /api/cart/checkout/confirm` in `server/server.js`). It charges a saved card off-session and polls Stripe.

**Current Gap**: 3-D Secure (3DS) is not supported in-app. When the saved-card off-session charge requires authentication, Stripe returns `last_payment_error.code = authentication_required` (or the order remains stuck in `Payment pending`). Currently, we detect this, return `status: 'requires_action'`, and display a graceful error prompting the user to fall back to the website checkout with tips on avoiding 3DS.

Because a significant portion of UK cards (especially under PSD2 Strong Customer Authentication rules) trigger a challenge on the first purchase, this bounce significantly degrades the PWA checkout experience.

## Proposed Solution
We can complete the Stripe 3DS challenge in-app using Stripe's client-side SDK.

1. **Upstream Data**: The order/payment-intent response already exposes `metadata.intent_secret` or `payment_intent.client_secret` (e.g. `pi_..._secret_...`) and the PaymentIntent ID.
2. **Client-side Integration**:
   - Embed Stripe.js (`https://js.stripe.com/v3/`) into `client/index.html`.
   - Initialize Stripe with the organization's Stripe publishable key (derived from the CodexFit configuration).
3. **Refined Checkout Flow**:
   - The server initiates the charge. If polling Stripe yields `requires_action`, the server returns `status: 'requires_action'` and includes the `client_secret` of the PaymentIntent.
   - The PWA client intercepts this response, loads Stripe.js, and calls:
     ```javascript
     stripe.confirmCardPayment(clientSecret, { payment_method: pmId })
     ```
     This triggers Stripe's native iframe/modal challenge UI in-app.
   - Upon successful challenge resolution, the client requests the server to resume polling `GET /orders/:id` until the order status resolves to `Paid`.

## Impacted Components
* `server/server.js`: Return the Stripe `client_secret` on `requires_action` during checkout confirmation, and ensure the order polling loop is resumeable.
* `client/src/ui/credits.js`: Inject Stripe.js script tag, handle the `confirmCardPayment` promise, and re-poll the backend upon success.
* `client/src/api.js`: Update the cart endpoints to support the two-step checkout/confirmation.
