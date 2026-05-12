/**
 * Boogi Bliss booking form handler
 * Cloudflare Pages Function — POST /api/book
 *
 * Receives a booking inquiry and sends it to hello@boogibliss.com via
 * Cloudflare's native email send binding (env.MAIL). Email Routing on
 * boogibliss.com then forwards to the real destination inbox.
 *
 * Required: wrangler.toml [[send_email]] binding named "MAIL" with
 * destination_address = "hello@boogibliss.com".
 */

import { EmailMessage } from 'cloudflare:email';

const ALLOWED_ORIGIN_HOSTS = new Set([
  'boogibliss.com',
  'www.boogibliss.com',
]);
const ALLOWED_ORIGIN_SUFFIXES = ['.boogibliss.pages.dev'];

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
const TO_ADDRESS = 'hello@boogibliss.com';

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

// Strip any character that could inject extra headers when interpolated
// into a single-line MIME header value (CR, LF, NUL).
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
  // Subject restricted to ASCII for header simplicity (avoid RFC 2047 encoding).
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

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) {
    return json({ error: 'Too many requests. Please try again later.' }, 429, request);
  }

  let data;
  try { data = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, request); }

  if (data._hp_company) {
    return json({ error: 'Verification failed' }, 403, request);
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
      <p style="font-size:11px;color:#9ca3af;margin-top:16px;">Submitted ${escapeHtml(submittedAt)} from IP ${escapeHtml(ip)}</p>
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
