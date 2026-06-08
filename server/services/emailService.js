/**
 * EmailService — All transactional emails
 * Providers: Brevo (default) | SendGrid | AWS SES | SMTP
 * Templates: verification, password reset, price alert, corporate event, daily digest
 */

const PROVIDER   = process.env.EMAIL_PROVIDER || 'brevo';
const FROM_EMAIL = process.env.FROM_EMAIL     || 'hello@apexfolio.app';
const FROM_NAME  = process.env.FROM_NAME      || 'ApexFolio';
const CLIENT_URL = process.env.CLIENT_URL     || 'http://localhost:3000';

async function sendEmail({ to, subject, html }) {
  if (process.env.NODE_ENV === 'development' && !process.env.FORCE_EMAIL) {
    console.log(`[Email DEV] To: ${to} | Subject: ${subject}`);
    return 'dev-mock-id';
  }
  switch (PROVIDER) {
    case 'brevo':     return sendViaBrevo({ to, subject, html });
    case 'sendgrid':  return sendViaSendGrid({ to, subject, html });
    case 'ses':       return sendViaSES({ to, subject, html });
    case 'smtp':      return sendViaSMTP({ to, subject, html });
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${PROVIDER}`);
  }
}

// ─── BREVO ────────────────────────────────────────────────────────────────────
// Uses Brevo REST API directly (no SDK needed — keeps dependencies minimal)
async function sendViaBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  const fetch = require('node-fetch');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender:  { name: FROM_NAME, email: FROM_EMAIL },
      to:      [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Brevo error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await res.json();
  return data.messageId || 'sent';
}

// ─── SENDGRID (fallback) ──────────────────────────────────────────────────────
async function sendViaSendGrid({ to, subject, html }) {
  const sg = require('@sendgrid/mail');
  sg.setApiKey(process.env.SENDGRID_API_KEY);
  const [res] = await sg.send({ to, from: { email: FROM_EMAIL, name: FROM_NAME }, subject, html });
  return res.headers['x-message-id'] || 'sent';
}

// ─── AWS SES ──────────────────────────────────────────────────────────────────
async function sendViaSES({ to, subject, html }) {
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const client = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const r = await client.send(new SendEmailCommand({
    Source: `${FROM_NAME} <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html } },
    },
  }));
  return r.MessageId;
}

// ─── SMTP ─────────────────────────────────────────────────────────────────────
async function sendViaSMTP({ to, subject, html }) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await t.sendMail({ from: `"${FROM_NAME}" <${FROM_EMAIL}>`, to, subject, html });
  return info.messageId;
}

// ─── BASE EMAIL TEMPLATE ──────────────────────────────────────────────────────
function base(content, preheader = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{margin:0;padding:0;background:#f0f2f7;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1d2e}
.wrap{max-width:580px;margin:0 auto;padding:28px 16px}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.hdr{background:#0a0d12;padding:22px 32px}
.logo{font-size:17px;font-weight:800;color:#fff;letter-spacing:.05em}
.logo span{color:#3b82f6}
.body{padding:32px}
.ftr{background:#f8f9fc;padding:14px 32px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb}
.btn{display:inline-block;padding:13px 28px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin:20px 0}
.data{background:#f8f9fc;border-radius:10px;padding:16px;margin:16px 0}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px}
.row:last-child{border:none}
.lbl{color:#6b7280}.val{font-weight:600;font-family:monospace}
.pos{color:#16a34a}.neg{color:#dc2626}
h2{margin:0 0 6px;font-size:22px;color:#0a0d12}
p{font-size:14px;color:#4b5563;line-height:1.6;margin:8px 0}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
</style>
</head><body>
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#fff">${preheader}</div>` : ''}
<div class="wrap"><div class="card">
<div class="hdr"><div class="logo">APEX<span>FOLIO</span></div></div>
<div class="body">${content}</div>
<div class="ftr">
  <a href="${CLIENT_URL}/alerts" style="color:#9ca3af">Manage alerts</a> &nbsp;·&nbsp;
  <a href="${CLIENT_URL}/unsubscribe" style="color:#9ca3af">Unsubscribe</a>
</div>
</div></div></body></html>`;
}

function fmt(n) {
  if (n == null) return 'N/A';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ─── VERIFICATION EMAIL ───────────────────────────────────────────────────────
async function sendVerificationEmail({ to, name, token }) {
  const url = `${CLIENT_URL}/verify/${token}`;
  const html = base(`
    <h2>Welcome to ApexFolio, ${name}! 👋</h2>
    <p>Your account is ready. Verify your email address to unlock all features including price alert notifications.</p>
    <a href="${url}" class="btn">Verify my email →</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:16px">Link expires in 48 hours. If you didn't create an account, you can safely ignore this.</p>
  `, 'Verify your ApexFolio email address');
  return sendEmail({ to, subject: 'Verify your ApexFolio account', html });
}

// ─── PASSWORD RESET EMAIL ─────────────────────────────────────────────────────
async function sendPasswordResetEmail({ to, name, token }) {
  const url = `${CLIENT_URL}/reset/${token}`;
  const html = base(`
    <h2>Reset your password</h2>
    <p>Hi ${name}, we received a request to reset your ApexFolio password.</p>
    <a href="${url}" class="btn">Reset password →</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:16px">This link expires in 1 hour. If you didn't request this, your account is safe — just ignore this email.</p>
  `, 'Reset your ApexFolio password');
  return sendEmail({ to, subject: 'Reset your ApexFolio password', html });
}

// ─── PRICE ALERT EMAIL ────────────────────────────────────────────────────────
async function sendAlertEmail({ to, ticker, companyName, context, alertType, lotLevel }) {
  const icons = { price_above:'🔺', price_below:'🔻', pct_gain:'📈', pct_loss:'📉', trailing_stop:'🛑' };
  const icon = icons[alertType] || '🔔';
  const subject = `${icon} Alert: ${ticker} — ${context.condition}`;

  const html = base(`
    <div style="font-size:32px;font-weight:800;letter-spacing:.04em;color:#0a0d12">${ticker}</div>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${companyName}${lotLevel ? ' · Lot-level alert' : ''}</div>
    <h2 style="font-size:18px">${context.condition}</h2>
    <div class="data">
      <div class="row"><span class="lbl">Current price</span><span class="val">${fmt(context.currentPrice)}</span></div>
      ${context.costBasis ? `<div class="row"><span class="lbl">Your cost basis</span><span class="val">${fmt(context.costBasis)}</span></div>` : ''}
      ${context.gainPct != null ? `<div class="row"><span class="lbl">Unrealized gain</span><span class="val pos">+${context.gainPct.toFixed(2)}%</span></div>` : ''}
      ${context.lossPct != null ? `<div class="row"><span class="lbl">Unrealized loss</span><span class="val neg">-${context.lossPct.toFixed(2)}%</span></div>` : ''}
      <div class="row"><span class="lbl">Triggered at</span><span class="val">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET</span></div>
    </div>
    <a href="${CLIENT_URL}/portfolio" class="btn">View portfolio →</a>
  `, `${ticker} price alert triggered`);

  return sendEmail({ to, subject, html });
}

// ─── CORPORATE EVENT EMAIL ────────────────────────────────────────────────────
async function sendEventEmail({ to, ticker, companyName, event }) {
  const meta = {
    earnings:    { label:'Earnings Report', color:'#3b82f6', bg:'#dbeafe' },
    dividend:    { label:'Dividend',         color:'#16a34a', bg:'#dcfce7' },
    split:       { label:'Stock Split',      color:'#d97706', bg:'#fef3c7' },
    acquisition: { label:'M&A Event',        color:'#7c3aed', bg:'#f3e8ff' },
    filing:      { label:'Regulatory Filing',color:'#0891b2', bg:'#cffafe' },
    other:       { label:'Corporate Event',  color:'#374151', bg:'#f3f4f6' },
  }[event.event_type] || { label:'Event', color:'#374151', bg:'#f3f4f6' };

  let dataRows = '';
  if (event.event_type === 'earnings') {
    dataRows = `
      <div class="row"><span class="lbl">EPS estimate</span><span class="val">${fmt(event.eps_estimate)}</span></div>
      ${event.eps_actual != null ? `<div class="row"><span class="lbl">EPS actual</span><span class="val ${event.eps_actual >= (event.eps_estimate||0) ? 'pos' : 'neg'}">${fmt(event.eps_actual)}</span></div>` : ''}
    `;
  } else if (event.event_type === 'dividend') {
    dataRows = `
      <div class="row"><span class="lbl">Amount/share</span><span class="val pos">${fmt(event.dividend_amount)}</span></div>
      ${event.ex_date ? `<div class="row"><span class="lbl">Ex-date</span><span class="val">${event.ex_date}</span></div>` : ''}
      ${event.pay_date ? `<div class="row"><span class="lbl">Pay date</span><span class="val">${event.pay_date}</span></div>` : ''}
    `;
  } else if (event.event_type === 'split') {
    dataRows = `<div class="row"><span class="lbl">Ratio</span><span class="val">${event.split_ratio}</span></div>`;
  }

  const html = base(`
    <div style="font-size:30px;font-weight:800;color:#0a0d12">${ticker}</div>
    <div style="font-size:13px;color:#6b7280;margin-bottom:14px">${companyName}</div>
    <span class="badge" style="background:${meta.bg};color:${meta.color}">${meta.label}</span>
    <h2 style="margin-top:14px;font-size:18px">${event.title}</h2>
    ${event.description ? `<p>${event.description}</p>` : ''}
    ${dataRows ? `<div class="data">${dataRows}</div>` : ''}
    <a href="${CLIENT_URL}/events" class="btn">View all events →</a>
  `, `${ticker}: ${event.title}`);

  return sendEmail({ to, subject: `${ticker}: ${event.title}`, html });
}

// ─── DAILY DIGEST ─────────────────────────────────────────────────────────────
async function sendDailyDigest({ to, portfolioValue, dayGainLoss, dayGainPct, topGainers, topLosers, upcomingEarnings }) {
  const gainClass = dayGainLoss >= 0 ? 'pos' : 'neg';
  const gRows = topGainers.map(g => `<div class="row"><span class="lbl">${g.ticker}</span><span class="val pos">+${g.pct.toFixed(2)}%</span></div>`).join('');
  const lRows = topLosers.map(l => `<div class="row"><span class="lbl">${l.ticker}</span><span class="val neg">${l.pct.toFixed(2)}%</span></div>`).join('');
  const eRows = upcomingEarnings.map(e => `<div class="row"><span class="lbl">${e.ticker}</span><span class="val">${e.date}</span></div>`).join('');

  const html = base(`
    <h2>Good morning 👋</h2>
    <p>Here's your portfolio summary for ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}.</p>
    <div class="data">
      <div class="row"><span class="lbl">Portfolio value</span><span class="val">${fmt(portfolioValue)}</span></div>
      <div class="row"><span class="lbl">Day P&L</span><span class="val ${gainClass}">${dayGainLoss>=0?'+':''}${fmt(dayGainLoss)} (${dayGainPct>=0?'+':''}${dayGainPct.toFixed(2)}%)</span></div>
    </div>
    ${gRows ? `<p style="font-weight:700;margin-bottom:4px">📈 Top Gainers</p><div class="data">${gRows}</div>` : ''}
    ${lRows ? `<p style="font-weight:700;margin-bottom:4px">📉 Top Losers</p><div class="data">${lRows}</div>` : ''}
    ${eRows ? `<p style="font-weight:700;margin-bottom:4px">📅 Upcoming Earnings</p><div class="data">${eRows}</div>` : ''}
    <a href="${CLIENT_URL}" class="btn">Open portfolio →</a>
  `, `Your portfolio is ${dayGainLoss>=0?'up':'down'} today`);

  return sendEmail({ to, subject: `Portfolio digest — ${new Date().toLocaleDateString()}`, html });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendAlertEmail,
  sendEventEmail,
  sendDailyDigest,
  sendEmail,
};
