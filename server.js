
require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'bookings.json');
const COUNTER = path.join(__dirname, 'counter.json');

// ---------- storage helpers ----------
function readBookings() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; } }
function writeBookings(x) { fs.writeFileSync(DATA, JSON.stringify(x, null, 2)); }
function nextBookingId() {
  let n = 1;
  try { n = JSON.parse(fs.readFileSync(COUNTER, 'utf8')).n + 1; } catch {}
  fs.writeFileSync(COUNTER, JSON.stringify({ n }));
  const year = new Date().getFullYear();
  return `SL-${year}-${String(n).padStart(5, '0')}`;
}

// ---------- razorpay ----------
const rzp = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

// ---------- email ----------
const mailer = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendMail(to, subject, html) {
  if (!mailer || !to) return;
  try {
    await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, html });
  } catch (e) {
    console.log('Email send failed:', e.message);
  }
}

function bookingEmailHtml(b) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
    <h2 style="color:#314b4b">Booking Confirmed ✓</h2>
    <p><b>Booking ID:</b> ${b.id}</p>
    <p><b>Session:</b> ${b.plan}</p>
    <p><b>Date & Time:</b> ${b.date} at ${b.time}</p>
    <p><b>Amount Paid:</b> ₹${b.amount}</p>
    <p style="color:#666;font-size:13px;margin-top:24px">Sidhh Listener is a listening/support service and is not psychological or medical treatment. If you are in crisis or danger, please contact local emergency services or a qualified professional immediately.</p>
  </div>`;
}

// ---------- slot config ----------
const WORK_START = 10; // 10:00
const WORK_END = 21;   // 21:00 (last possible end time)
const SLOT_STEP_MIN = 60;

function durationHours(plan) { return plan && plan.startsWith('3') ? 3 : 1; }

function generateSlots(date, plan) {
  const dur = durationHours(plan);
  const slots = [];
  for (let h = WORK_START; h + dur <= WORK_END; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`);
  }
  const bookings = readBookings().filter(b =>
    b.date === date && (b.status === 'paid' || (b.status === 'pending' && Date.now() - new Date(b.createdAt).getTime() < 15 * 60 * 1000))
  );
  const taken = new Set();
  bookings.forEach(b => {
    const bDur = durationHours(b.plan);
    const startH = parseInt(b.time.split(':')[0], 10);
    for (let h = startH; h < startH + bDur; h++) taken.add(`${String(h).padStart(2, '0')}:00`);
  });
  return slots.filter(s => {
    const startH = parseInt(s.split(':')[0], 10);
    for (let h = startH; h < startH + dur; h++) {
      if (taken.has(`${String(h).padStart(2, '0')}:00`)) return false;
    }
    return true;
  });
}

function isSlotFree(date, time, plan) {
  return generateSlots(date, plan).includes(time);
}

// ---------- routes ----------
app.get('/api/config', (req, res) => {
  res.json({ whatsapp: process.env.WHATSAPP_NUMBER || '' });
});

app.get('/api/slots', (req, res) => {
  const { date, plan } = req.query;
  if (!date || !plan) return res.status(400).json({ error: 'date and plan are required' });
  res.json({ slots: generateSlots(date, plan) });
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { name, age, gender, place, phone, email, plan, date, time, message, consent } = req.body;
    if (!name || !age || !gender || !place || !phone || !plan || !date || !time) {
      return res.status(400).json({ error: 'Please complete all required fields.' });
    }
    if (!consent) return res.status(400).json({ error: 'Please accept the Terms and Privacy Policy to continue.' });
    if (!isSlotFree(date, time, plan)) {
      return res.status(409).json({ error: 'That slot was just booked by someone else. Please pick another time.' });
    }
    const amount = plan.startsWith('3') ? 500 : 200;
    if (!rzp) return res.status(503).json({ error: 'Payment gateway is not configured yet. Add Razorpay keys in the environment settings.' });

    const order = await rzp.orders.create({ amount: amount * 100, currency: 'INR', receipt: 'SL' + Date.now() });
    const bookingId = nextBookingId();
    const bookings = readBookings();
    bookings.push({
      id: bookingId, orderId: order.id, name, age, gender, place, phone, email, plan, date, time, message,
      status: 'pending', amount, createdAt: new Date().toISOString()
    });
    writeBookings(bookings);
    res.json({ key: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: amount * 100, currency: 'INR', bookingId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ ok: false, error: 'Payment verification failed.' });

  const bookings = readBookings();
  const b = bookings.find(x => x.orderId === razorpay_order_id);
  if (!b) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  b.status = 'paid';
  b.paymentId = razorpay_payment_id;
  b.paidAt = new Date().toISOString();
  writeBookings(bookings);

  sendMail(b.email, `Booking Confirmed — ${b.id}`, bookingEmailHtml(b));
  sendMail(process.env.ADMIN_EMAIL, `New paid booking — ${b.id}`, bookingEmailHtml(b) + `<p>Phone: ${b.phone}</p>`);

  res.json({ ok: true, booking: b });
});

app.post('/api/webhook', (req, res) => {
  const raw = JSON.stringify(req.body);
  const signature = req.headers['x-razorpay-signature'];
  if (process.env.RAZORPAY_WEBHOOK_SECRET) {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (expected !== signature) return res.status(400).send('invalid signature');
  }
  if (req.body.event === 'order.paid') {
    const orderId = req.body.payload?.order?.entity?.id;
    const bookings = readBookings();
    const b = bookings.find(x => x.orderId === orderId);
    if (b && b.status !== 'paid') {
      b.status = 'paid';
      b.webhookReceivedAt = new Date().toISOString();
      writeBookings(bookings);
      sendMail(b.email, `Booking Confirmed — ${b.id}`, bookingEmailHtml(b));
      sendMail(process.env.ADMIN_EMAIL, `New paid booking (webhook) — ${b.id}`, bookingEmailHtml(b));
    }
  }
  res.json({ received: true });
});

app.get('/api/booking/:orderId', (req, res) => {
  const b = readBookings().find(x => x.orderId === req.params.orderId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

// ---------- admin ----------
function checkAdmin(req, res) {
  if (!process.env.ADMIN_TOKEN || req.headers.authorization !== 'Bearer ' + process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_TOKEN || password !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }
  res.json({ ok: true });
});

app.get('/api/bookings', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(readBookings().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.listen(PORT, () => console.log('Sidhh Listener running on ' + PORT));
