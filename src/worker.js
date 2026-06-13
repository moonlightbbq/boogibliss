/**
 * Boogi Bliss — Cloudflare Worker (Static Assets + booking API)
 *
 * Serves the static site from /public via env.ASSETS, and handles
 * POST /api/book by sending an email to sheilia@thewayagency.com via the
 * native Cloudflare send binding (env.MAIL). Note: hello@boogibliss.com is
 * the public-facing contact address shown to users, NOT the delivery target.
 *
 * Bindings (see wrangler.toml):
 *   ASSETS — static asset binding for ./public
 *   MAIL   — send_email binding, destination locked to sheilia@thewayagency.com
 */

import { EmailMessage } from 'cloudflare:email';

const ALLOWED_ORIGIN_HOSTS = new Set([
  'boogibliss.com',
  'www.boogibliss.com',
]);
const ALLOWED_ORIGIN_SUFFIXES = ['.workers.dev', '.boogibliss.pages.dev'];

const EVENT_TYPES = new Set([
  'Wedding',
  'Birthday',
  'Corporate Event',
  'Anniversary / Shower',
  'Church / Community',
  'Other',
]);

const RATE_LIMIT_MAX = 10;
const rateLimitMap = new Map();

const FROM_ADDRESS = 'noreply@boogibliss.com';
const TO_ADDRESS = 'sheilia@thewayagency.com';

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()',
  // challenges.cloudflare.com is pre-allowed for Cloudflare Turnstile. It is
  // inert until Turnstile is activated (no widget = no request to that origin),
  // so enabling Turnstile later needs no CSP change. See handleBooking().
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
};

function isAllowedOrigin(origin) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (ALLOWED_ORIGIN_HOSTS.has(host)) return true;
  return ALLOWED_ORIGIN_SUFFIXES.some(s => host.endsWith(s));
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function checkRateLimit(ip) {
  const hourBucket = Math.floor(Date.now() / 3600000);
  const key = `${ip}:${hourBucket}`;
  for (const k of rateLimitMap.keys()) {
    if (!k.endsWith(`:${hourBucket}`)) rateLimitMap.delete(k);
  }
  const count = rateLimitMap.get(key) || 0;
  if (count >= RATE_LIMIT_MAX) return false;
  rateLimitMap.set(key, count + 1);
  return true;
}

function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }
function safeHeader(s) { return String(s || '').replace(/[\r\n\0]/g, ' ').trim(); }

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function buildMime({ subject, fromAddress, toAddress, replyToName, replyToEmail, html }) {
  const safeSubject = safeHeader(subject).replace(/[^\x20-\x7E]/g, '');
  const safeReplyName = safeHeader(replyToName).replace(/"/g, '');
  const safeReplyEmail = safeHeader(replyToEmail);
  const msgId = `<${crypto.randomUUID()}@boogibliss.com>`;

  const headers = [
    `From: Boogi Bliss Bookings <${fromAddress}>`,
    `To: Boogi Bliss <${toAddress}>`,
    `Reply-To: "${safeReplyName}" <${safeReplyEmail}>`,
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
  ].join('\r\n');

  return headers + '\r\n\r\n' + html + '\r\n';
}

// Cloudflare Turnstile server-side verification. Dormant until env.TURNSTILE_SECRET
// is bound (see handleBooking). Returns true on a valid, unused token.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    const out = await res.json();
    return out && out.success === true;
  } catch (err) {
    console.error('turnstile verify failed', err && err.message);
    return false;
  }
}

async function handleBooking(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) {
    return json({ error: 'Too many requests. Please try again later.' }, 429, request);
  }

  // Server-side Origin allowlist. Modern browsers always send Origin on fetch
  // POST (same-origin included), so this is safe for the real form and blocks
  // naive cross-origin / no-Origin bot posts. Stronger bot defense (Turnstile)
  // is wired below; native Rate Limiting remains a recommended follow-up.
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) {
    return json({ error: 'Invalid origin' }, 403, request);
  }

  let data;
  try { data = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, request); }

  if (data._hp_company) {
    return json({ error: 'Verification failed' }, 403, request);
  }

  // Turnstile gate — DORMANT until env.TURNSTILE_SECRET is bound.
  // ⚠️ Activate in lockstep: set TURNSTILE_SITEKEY in public/index.html AND
  // deploy that first, THEN bind TURNSTILE_SECRET. Binding the secret without a
  // matching site key in the page makes the widget send no token and every
  // booking is rejected here. See NOTES.md → "Turnstile".
  if (env.TURNSTILE_SECRET) {
    const token = typeof data['cf-turnstile-response'] === 'string' ? data['cf-turnstile-response'] : '';
    if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET, ip))) {
      return json({ error: 'Verification failed. Please refresh and try again.' }, 403, request);
    }
  }

  const name = data.name && typeof data.name === 'string' ? stripTags(data.name.trim()).slice(0, 100) : '';
  if (!name) return json({ error: 'Name is required' }, 400, request);

  const emailRaw = data.email && typeof data.email === 'string' ? data.email.trim().slice(0, 254) : '';
  if (!emailRaw) return json({ error: 'Email is required' }, 400, request);
  if (/[\r\n]/.test(emailRaw)) return json({ error: 'Invalid email address' }, 400, request);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return json({ error: 'Invalid email address' }, 400, request);
  }
  const email = emailRaw;

  let phone = '';
  if (data.phone && typeof data.phone === 'string') {
    phone = data.phone.replace(/\D/g, '').slice(0, 15);
  }

  const eventType = data.event_type && typeof data.event_type === 'string' ? data.event_type.trim() : '';
  if (!eventType || !EVENT_TYPES.has(eventType)) {
    return json({ error: 'Please select a valid event type' }, 400, request);
  }

  const eventDate = data.event_date && typeof data.event_date === 'string' ? data.event_date.trim() : '';
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(Date.parse(eventDate))) {
    return json({ error: 'Please provide a valid event date' }, 400, request);
  }

  let guestCount = '';
  if (data.guest_count !== undefined && data.guest_count !== null && data.guest_count !== '') {
    const n = parseInt(String(data.guest_count), 10);
    if (Number.isNaN(n) || n < 1 || n > 10000) {
      return json({ error: 'Guest count looks off — try a number between 1 and 10000' }, 400, request);
    }
    guestCount = String(n);
  }

  const location = data.location && typeof data.location === 'string'
    ? stripTags(data.location).slice(0, 200) : '';
  const notes = data.notes && typeof data.notes === 'string'
    ? data.notes.slice(0, 5000) : '';

  const submittedAt = new Date().toISOString();
  const rows = [
    ['Name', escapeHtml(name)],
    ['Email', `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`],
    phone ? ['Phone', `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`] : null,
    ['Event Type', escapeHtml(eventType)],
    ['Event Date', escapeHtml(eventDate)],
    guestCount ? ['Guest Count', escapeHtml(guestCount)] : null,
    location ? ['Location', escapeHtml(location)] : null,
    notes ? ['Notes', escapeHtml(notes).replace(/\n/g, '<br>')] : null,
  ].filter(Boolean);

  const tableRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;color:#6b7280;border-bottom:1px solid #e5e7eb;width:140px;vertical-align:top;">${label}</td>
      <td style="padding:8px 12px;font-weight:500;border-bottom:1px solid #e5e7eb;color:#1f2937;">${value}</td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;background:#faf6ee;">
      <h2 style="color:#173358;font-family:Georgia,serif;margin:0 0 4px;">New Booking Inquiry</h2>
      <p style="color:#8a7556;margin:0 0 20px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;">Boogi Bliss</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #e5e7eb;">
        ${tableRows}
      </table>
      <p style="font-size:11px;color:#9ca3af;margin-top:16px;">Submitted ${escapeHtml(submittedAt)}</p>
    </div>
  `;

  const subject = `Booking inquiry - ${name} | ${eventType} | ${eventDate}`;
  const rawMime = buildMime({
    subject,
    fromAddress: FROM_ADDRESS,
    toAddress: TO_ADDRESS,
    replyToName: name,
    replyToEmail: email,
    html,
  });

  try {
    const message = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, rawMime);
    await env.MAIL.send(message);
  } catch (err) {
    console.error('env.MAIL.send failed', err && err.message, err && err.stack);
    return json({ error: 'Email delivery failed. Please email hello@boogibliss.com directly.' }, 502, request);
  }

  return json({ ok: true }, 200, request);
}

function withSecurityHeaders(response, request) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

  const contentType = headers.get('Content-Type') || '';
  const path = new URL(request.url).pathname;
  if (contentType.includes('text/html') || path === '/' || path.endsWith('.html')) {
    headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  } else if (contentType.includes('css') || contentType.includes('javascript') || /\.(css|js)$/.test(path)) {
    headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/book') {
      if (request.method === 'POST') return handleBooking(request, env);
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(request) });
      }
      return json({ error: 'Method Not Allowed' }, 405, request);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse, request);
  },
};
