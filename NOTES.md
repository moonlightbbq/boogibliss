# Boogi Bliss — operator follow-ups

Three items from the deep review need Cloudflare dashboard / DNS / mailbox
access and can't be done from the repo. The code side of each is already wired;
these are the manual steps to finish them.

## 1. DMARC record (email deliverability)

SPF and DKIM are already present and aligned for `boogibliss.com` (Cloudflare
`cf2024-1` selector), so booking mail should authenticate. The only gap is a
missing DMARC policy. Add this DNS record (Cloudflare dashboard → DNS):

| Field | Value |
|-------|-------|
| Type  | `TXT` |
| Name  | `_dmarc` |
| Content | `v=DMARC1; p=none; rua=mailto:hello@boogibliss.com` |

`p=none` is monitor-only (safe to start). Review the `rua` aggregate reports for
a few weeks, then consider tightening to `p=quarantine`.

## 2. Turnstile (bot protection) — code is wired, dormant

The form is protected by a server-side Origin allowlist + honeypot today.
Turnstile is fully wired but **OFF** until you provide keys. Activate in this
exact order so you never reject a real booking:

1. Cloudflare dashboard → **Turnstile** → add a widget for `boogibliss.com`
   (+ `www`). Copy the **Site Key** (public) and **Secret Key** (private).
2. In `public/index.html`, set `var TURNSTILE_SITEKEY = '...'` (the site key).
   The widget then renders into `#cf-turnstile` and injects a hidden
   `cf-turnstile-response` field the booking POST already forwards.
3. **Deploy that first** (merge to `main`). Confirm the widget appears and a
   real booking still goes through.
4. Only then bind the secret so the Worker enforces it:
   `npx wrangler secret put TURNSTILE_SECRET` (paste the secret key), or set it
   in the dashboard (Workers → boogibliss → Settings → Variables, encrypted).

⚠️ If you bind `TURNSTILE_SECRET` **before** the site key is live in the page,
the widget sends no token and **every booking is rejected** (`worker.js`
`handleBooking` → Turnstile gate). Site key first, secret second.

CSP already allows `challenges.cloudflare.com`, so no further changes needed.

## 3. Live deliverability test

After this branch is merged + deployed, send one real booking through the form
and confirm it lands in **sheilia@thewayagency.com's inbox (not Junk)**. If it
junks, the DMARC record above is the most likely fix. (I can't verify this from
the repo — it needs access to that mailbox.)
