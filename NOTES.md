# Boogi Bliss — operator follow-ups

Three items from the deep review need Cloudflare dashboard / DNS / mailbox
access and can't be done from the repo. The code side of each is already wired;
these are the manual steps to finish them.

## 0. Counting submissions

Every booking attempt is recorded in the `boogibliss-bookings` D1 database,
including the ones the form rejects. Before this the delivered email was the
only lasting evidence a booking happened, so anything turned away before the
send vanished with no trace beyond a Workers Log line that ages out in days —
which is why the form's submission count was, for three months, unknowable.

```bash
# How many submissions, broken down by what happened to them
npx wrangler d1 execute boogibliss-bookings --remote \
  --command "SELECT outcome, reason, COUNT(*) AS n FROM bookings GROUP BY outcome, reason ORDER BY n DESC"

# The real inquiries, newest first
npx wrangler d1 execute boogibliss-bookings --remote \
  --command "SELECT created_at, name, email, phone, event_type, event_date FROM bookings WHERE outcome='accepted' ORDER BY created_at DESC LIMIT 50"

# Accepted but the email never went out — chase these by hand
npx wrangler d1 execute boogibliss-bookings --remote \
  --command "SELECT created_at, name, email, phone FROM bookings WHERE outcome='accepted' AND reason='email_send_failed'"
```

`outcome='accepted'` means the submission passed every check and we tried to
mail it. `reason` explains a rejection (`honeypot`, `invalid_email`,
`missing_name`, …) or, on an accepted row, flags a delivery failure. Rate-limit
and bad-Origin hits are deliberately **not** recorded — they are unbounded bot
noise, and logging them would let a bot fill the table.

Writes are best-effort by design: if D1 is unavailable the booking still goes
through and only the log line is lost. Never make this path throw.

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
