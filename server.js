import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const sb = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

const JWT_SECRET       = process.env.JWT_SECRET || 'change-me';
const ADMIN_RESET_CODE = process.env.ADMIN_RESET_CODE || '100510';

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT   = process.env.TELEGRAM_ADMIN_CHAT;
const TELEGRAM_CHANNEL      = process.env.TELEGRAM_CHANNEL || '@Lucky21_Wheel';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'Numbers_Betting_bot';

async function sendTelegram(chatId, message, keyboard) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const body = { chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) body.reply_markup = keyboard;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { console.error('Telegram:', e.message); }
}
async function notifyAdmin(m) { return sendTelegram(TELEGRAM_ADMIN_CHAT, m); }
async function notifyChannel(m) { return sendTelegram(TELEGRAM_CHANNEL, m); }

function escapeTele(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function maskPhone(p) { if (!p) return '—'; const s = String(p); return s.length < 6 ? s : s.slice(0,4)+'****'+s.slice(-2); }
function publicUserId(pid) { return pid === null || pid === undefined ? '—' : 'U' + String(pid).padStart(5, '0'); }
function generateTicketRef() { return 'TK' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(); }
function sign(p) { return jwt.sign(p, JWT_SECRET, { expiresIn: '30d' }); }

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function getSettings() {
  const { data, error } = await sb.from('app_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}
async function getTickets() {
  const s = await getSettings();
  const { data, error } = await sb.from('tickets').select('*').eq('round_number', s.round_number).order('ticket_number');
  if (error) throw error;
  return data || [];
}
async function getNbSettings() {
  const { data, error } = await sb.from('nb_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}
async function getNbTickets(roundNumber) {
  const { data, error } = await sb.from('nb_tickets').select('*').eq('round_number', roundNumber).order('number');
  if (error) throw error;
  return data || [];
}
async function generateReferralCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789';
  for (let i = 0; i < 10; i++) {
    let code = '';
    for (let j = 0; j < 3; j++) code += L[Math.floor(Math.random() * L.length)];
    for (let j = 0; j < 4; j++) code += D[Math.floor(Math.random() * D.length)];
    const { data } = await sb.from('users').select('id').eq('referral_code', code).maybeSingle();
    if (!data) return code;
  }
  throw new Error('Could not generate code');
}
function computePrize(placeIndex, settings, revenue) {
  const usePct = !!settings.use_percent_prizes;
  const pcts = Array.isArray(settings.prize_percents) ? settings.prize_percents : [];
  const fixes = Array.isArray(settings.prizes) ? settings.prizes : [];
  if (usePct) {
    const pct = pcts[placeIndex] !== undefined ? Number(pcts[placeIndex]) : 0;
    return { amount: Math.round(revenue * pct / 100), percent: pct };
  }
  return { amount: Number(fixes[placeIndex] !== undefined ? fixes[placeIndex] : (settings.prize || 0)), percent: null };
}

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    botUsername: TELEGRAM_BOT_USERNAME,
    channelUsername: TELEGRAM_CHANNEL
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password, referralCode } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Please fill all fields' });
    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    const cleanPassword = String(password).trim();
    if (cleanPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
    const { data: exists } = await sb.from('users').select('id').eq('phone', cleanPhone).maybeSingle();
    if (exists) return res.status(400).json({ error: 'Phone already registered' });
    let referredBy = null;
    if (referralCode && String(referralCode).trim()) {
      const { data: ref } = await sb.from('users').select('id').eq('referral_code', String(referralCode).trim().toUpperCase()).maybeSingle();
      if (ref) referredBy = ref.id;
    }
    const hash = await bcrypt.hash(cleanPassword, 10);
    const myCode = await generateReferralCode();
    const { error } = await sb.from('users').insert({
      name: cleanName, phone: cleanPhone, password_hash: hash,
      password_plain: cleanPassword, role: 'user', balance: 0,
      referral_code: myCode, referred_by: referredBy, banned: false
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, referral_code: myCode, referred: !!referredBy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    const cleanPhone = String(phone).trim();
    const cleanPassword = String(password).trim();
    const { data: user, error } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    if (error) { console.log('❌ DB error:', error.message); return res.status(500).json({ error: 'DB error' }); }
    if (!user) { console.log('❌ No user for phone:', cleanPhone); return res.status(401).json({ error: 'Invalid phone number or password' }); }
    if (user.banned) return res.status(403).json({ error: 'Your account has been banned.' });
    const ok = await bcrypt.compare(cleanPassword, user.password_hash);
    if (!ok) { console.log('❌ bcrypt mismatch:', cleanPhone); return res.status(401).json({ error: 'Invalid phone number or password' }); }
    const token = sign({ id: user.id, role: user.role, phone: user.phone });
    console.log('✅ Login OK:', cleanPhone, '| role:', user.role);
    res.json({ token, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/change-password', auth, adminOnly, async (req, res) => {
  try {
    const { newPassword, code } = req.body;
    if (!newPassword || !code) return res.status(400).json({ error: 'Password and code required' });
    if (String(code).trim() !== ADMIN_RESET_CODE) return res.status(403).json({ error: 'Invalid secret code' });
    const clean = String(newPassword).trim();
    if (clean.length < 4) return res.status(400).json({ error: 'Password too short' });
    const hash = await bcrypt.hash(clean, 10);
    const { error } = await sb.from('users').update({ password_hash: hash, password_plain: clean }).eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const settings = await getSettings();
    const tickets = await getTickets();
    let me;
    if (req.user.role === 'admin') {
      const { data } = await sb.from('users').select('id,name,phone,role,balance,free_tickets,referral_code,active_referrals,public_id').eq('id', req.user.id).single();
      me = data || { id: req.user.id, name: 'Admin', phone: req.user.phone, role: 'admin', balance: 0, free_tickets: 0 };
    } else {
      const { data } = await sb.from('users').select('id,name,phone,balance,role,referral_code,active_referrals,free_tickets,has_bought_ticket,public_id').eq('id', req.user.id).single();
      me = data;
    }
    res.json({ settings, tickets, me });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/referrals', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.json({ referrals: [], activeCount: 0 });
    const { data } = await sb.from('users').select('id,name,phone,has_bought_ticket,created_at').eq('referred_by', req.user.id).order('created_at', { ascending: false });
    const refs = data || [];
    res.json({ referrals: refs, activeCount: refs.filter(r => r.has_bought_ticket).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify-ticket', auth, async (req, res) => {
  try {
    const { game, ticketNumber, phone, printerCode } = req.body;
    if (printerCode && String(printerCode).trim()) {
      const code = String(printerCode).trim().toUpperCase();
      let { data: row } = await sb.from('tickets').select('*').eq('printer_code', code).maybeSingle();
      if (row) return res.json(await buildWheelVerify(row));
      const { data: nbRow } = await sb.from('nb_tickets').select('*').eq('printer_code', code).maybeSingle();
      if (nbRow) return res.json(await buildNbVerify(nbRow));
      return res.status(404).json({ error: 'No ticket found for that printer code' });
    }
    if (!ticketNumber) return res.status(400).json({ error: 'Ticket number or printer code required' });
    const num = Number(ticketNumber);
    if (!Number.isFinite(num)) return res.status(400).json({ error: 'Invalid ticket number' });
    if (game === 'nb') {
      const s = await getNbSettings();
      const { data: rows } = await sb.from('nb_tickets').select('*').eq('round_number', s.round_number).eq('number', num);
      if (!rows || !rows.length) return res.status(404).json({ error: 'No NB ticket with that ID' });
      const row = phone ? (rows.find(r => r.phone === String(phone).trim()) || rows[0]) : rows[0];
      return res.json(await buildNbVerify(row));
    }
    const settings = await getSettings();
    const { data: rows } = await sb.from('tickets').select('*').eq('round_number', settings.round_number).eq('ticket_number', num);
    if (!rows || !rows.length) return res.status(404).json({ error: 'No ticket with that ID' });
    const row = phone ? (rows.find(r => r.phone === String(phone).trim()) || rows[0]) : rows[0];
    return res.json(await buildWheelVerify(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function buildWheelVerify(t) {
  const { data: u } = await sb.from('users').select('name,phone,public_id').eq('id', t.user_id).maybeSingle();
  const settings = await getSettings();
  const isWinner = Array.isArray(settings.winner_numbers) && settings.winner_numbers.includes(t.ticket_number);
  const roundFinished = settings.round_state === 'finished';
  let prize = null, percent = null;
  if (isWinner && roundFinished && Array.isArray(settings.winners)) {
    const idx = settings.winner_numbers.indexOf(t.ticket_number);
    const w = settings.winners[idx];
    if (w) { prize = w.prize; percent = w.percent; }
  }
  return {
    ok: true, game: 'Lucky Wheel',
    number: t.ticket_number, round: t.round_number,
    owner_name: u?.name || t.user_name || '—',
    owner_phone: u?.phone || t.phone || '—',
    public_code: publicUserId(u?.public_id),
    sold_date: t.sold_date, is_free: t.used_free_ticket,
    printer_code: t.printer_code,
    is_winner: isWinner, round_finished: roundFinished, prize, percent
  };
}

async function buildNbVerify(t) {
  const { data: u } = await sb.from('users').select('name,phone,public_id').eq('id', t.user_id).maybeSingle();
  const s = await getNbSettings();
  const roundFinished = s.round_state === 'finished';
  let isWinner = false, prize = null, percent = null;
  if (roundFinished && Array.isArray(s.winners) && u) {
    for (const w of s.winners) {
      if (w.public_id && u.public_id && w.public_id === u.public_id) { isWinner = true; prize = w.prize; percent = w.percent; break; }
    }
  }
  return {
    ok: true, game: 'Number Betting',
    number: t.number, round: t.round_number,
    owner_name: u?.name || t.user_name || '—',
    owner_phone: u?.phone || t.phone || '—',
    public_code: publicUserId(u?.public_id),
    sold_date: t.sold_date, is_free: t.is_free,
    printer_code: t.printer_code,
    is_winner: isWinner, round_finished: roundFinished, prize, percent
  };
}

app.post('/api/ticket-receipt', auth, async (req, res) => {
  try {
    const { game, round, tickets } = req.body;
    const settings = game === 'nb' ? await getNbSettings() : await getSettings();
    let owner = { name: 'Admin', phone: '-' };
    if (req.user.role !== 'admin') {
      const { data: u } = await sb.from('users').select('name,phone,public_id').eq('id', req.user.id).single();
      if (u) owner = { name: u.name, phone: u.phone, public_code: publicUserId(u.public_id) };
    }
    let map = {};
    if (game === 'nb') {
      const { data } = await sb.from('nb_tickets').select('number, printer_code').eq('round_number', round).in('number', tickets);
      (data || []).forEach(r => { if (!map[r.number]) map[r.number] = r.printer_code; });
    } else {
      const { data } = await sb.from('tickets').select('ticket_number, printer_code').eq('round_number', round).in('ticket_number', tickets);
      (data || []).forEach(r => { if (!map[r.ticket_number]) map[r.ticket_number] = r.printer_code; });
    }
    const enriched = tickets.map(t => {
      const num = typeof t === 'object' ? t.number : t;
      return { number: num, printer_code: map[num] || null, matches: typeof t === 'object' ? t.matches : undefined };
    });
    res.json({
      ok: true,
      game: game === 'nb' ? 'Number Betting' : 'Lucky Wheel',
      round, tickets: enriched, owner,
      ref: generateTicketRef(), date: new Date().toISOString(),
      price: game === 'nb' ? Number(settings.price_per_purchase) : Number(settings.ticket_price)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb.from('users').select('id,name,phone,balance,active_referrals,free_tickets,has_bought_ticket,referral_code,referred_by,public_id').eq('role', 'user').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});
app.get('/api/admin/users/full', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb.from('users').select('id,name,phone,balance,role,referral_code,active_referrals,free_tickets,has_bought_ticket,banned,password_plain,public_id').eq('role', 'user').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});
app.post('/api/admin/users/reset-password', auth, adminOnly, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    const clean = String(newPassword).trim();
    if (clean.length < 4) return res.status(400).json({ error: 'Password too short' });
    const hash = await bcrypt.hash(clean, 10);
    const { error } = await sb.from('users').update({ password_hash: hash, password_plain: clean }).eq('id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/ban', auth, adminOnly, async (req, res) => {
  try {
    const { userId, banned } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const { error } = await sb.from('users').update({ banned: !!banned }).eq('id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/balance', auth, adminOnly, async (req, res) => {
  const { userId, amount } = req.body;
  const { data: user } = await sb.from('users').select('balance').eq('id', userId).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const nb = Number(user.balance) + Number(amount);
  if (nb < 0) return res.status(400).json({ error: 'Balance cannot be negative' });
  const { error } = await sb.from('users').update({ balance: nb }).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, balance: nb });
});

/* ================= WHEEL ASSIGN — free re-assign, sold tickets re-usable ================= */
app.post('/api/admin/tickets/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers, useFreeTicket } = req.body;
    if (!name || !phone || !numbers?.length) return res.status(400).json({ error: 'Missing fields' });
    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    const isFirst = !user || !user.has_bought_ticket;
    if (!user) {
      if (!password) return res.status(400).json({ error: 'Password needed for new user' });
      const hash = await bcrypt.hash(String(password).trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({
        name: cleanName, phone: cleanPhone, password_hash: hash,
        password_plain: String(password).trim(), role: 'user',
        balance: Math.max(0, Number(balance) || 0),
        referral_code: newCode, banned: false
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      if (nb < 0) return res.status(400).json({ error: 'Balance cannot be negative' });
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
      user.name = cleanName; user.balance = nb;
    }
    const settings = await getSettings();
    let usedFree = false;
    if (useFreeTicket && (user.free_tickets || 0) > 0) {
      await sb.from('users').update({ free_tickets: user.free_tickets - 1 }).eq('id', user.id);
      user.free_tickets -= 1;
      usedFree = true;
    }
    const now = new Date().toISOString();
    for (const n of numbers) {
      // Always insert a new row — sold numbers can be re-sold
      await sb.from('tickets').insert({
        ticket_number: n, user_id: user.id, user_name: cleanName,
        phone: cleanPhone, sold_date: now, round_number: settings.round_number,
        used_free_ticket: usedFree
      });
    }
    if (isFirst) {
      await sb.from('users').update({ has_bought_ticket: true }).eq('id', user.id);
      if (user.referred_by) {
        const { data: ref } = await sb.from('users').select('id,name,active_referrals,free_tickets').eq('id', user.referred_by).single();
        if (ref) {
          const na = (ref.active_referrals || 0) + 1;
          const goal = settings.referral_goal || 8;
          const reward = settings.referral_reward || 1;
          let nf = ref.free_tickets || 0;
          if (na % goal === 0) nf += reward;
          await sb.from('users').update({ active_referrals: na, free_tickets: nf }).eq('id', ref.id);
        }
      }
    }
    res.json({ user: { ...user, public_code: publicUserId(user.public_id) }, numbers, usedFreeTicket: usedFree, receipt_ref: generateTicketRef() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/settings', auth, adminOnly, async (req, res) => {
  try {
    const { duration, winners, prize, ticketPrice, referralGoal, referralReward, prizes, salesDuration, prizePercents, usePercentPrizes } = req.body;
    const upd = {
      duration_seconds: Math.max(5, Number(duration) || 30),
      winner_count: Math.min(60, Math.max(1, Number(winners) || 1)),
      prize: Math.max(0, Number(prize) || 0),
      ticket_price: Math.max(0, Number(ticketPrice) || 0)
    };
    if (referralGoal !== undefined) upd.referral_goal = Math.max(1, Number(referralGoal) || 8);
    if (referralReward !== undefined) upd.referral_reward = Math.max(1, Number(referralReward) || 1);
    if (Array.isArray(prizes)) upd.prizes = prizes.map(p => Math.max(0, Number(p) || 0));
    if (Array.isArray(prizePercents)) upd.prize_percents = prizePercents.map(p => Math.max(0, Number(p) || 0));
    if (usePercentPrizes !== undefined) upd.use_percent_prizes = !!usePercentPrizes;
    if (salesDuration !== undefined) upd.sales_duration = Math.max(1, Number(salesDuration) || 120);
    const { error } = await sb.from('app_settings').update(upd).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tickets/count', auth, adminOnly, async (req, res) => {
  try {
    const count = Math.min(60, Math.max(2, Number(req.body.count) || 12));
    const settings = await getSettings();
    const { data: sold } = await sb.from('tickets').select('id').eq('round_number', settings.round_number).not('user_id', 'is', null);
    if (sold?.length) return res.status(400).json({ error: 'Reset round first' });
    await sb.from('tickets').delete().eq('round_number', settings.round_number);
    const rows = Array.from({ length: count }, (_, i) => ({ ticket_number: i + 1, round_number: settings.round_number }));
    const { error } = await sb.from('tickets').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
    await sb.from('app_settings').update({ ticket_count: count, round_state: 'idle', winner_numbers: [], winners: [] }).eq('id', 1);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tickets/reset-one', auth, adminOnly, async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Missing number' });
    const settings = await getSettings();
    const { error } = await sb.from('tickets').delete().eq('round_number', settings.round_number).eq('ticket_number', number);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/start-sales', auth, adminOnly, async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.sales_state === 'open') return res.status(400).json({ error: 'Sales already open' });
    if (settings.round_state === 'spinning') return res.status(400).json({ error: 'Wheel is spinning' });
    const { error } = await sb.from('app_settings').update({ sales_state: 'open', sales_started_at: new Date().toISOString() }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    notifyChannel(`🎡 <b>Wheel Sales Open!</b> Round #${settings.round_number}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/close-sales', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await sb.from('app_settings').update({ sales_state: 'closed' }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/spin/start', auth, adminOnly, async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.round_state === 'spinning') return res.status(400).json({ error: 'Already spinning' });
    const { data: sold } = await sb.from('tickets').select('*').eq('round_number', settings.round_number).not('user_id', 'is', null);
    if (!sold?.length) return res.status(400).json({ error: 'No sold tickets yet' });
    // Unique winner numbers
    const uniqueSold = [...new Set(sold.map(t => t.ticket_number))];
    const shuffled = uniqueSold.sort(() => Math.random() - 0.5);
    const winnerNumbers = shuffled.slice(0, Math.min(settings.winner_count, shuffled.length));
    const spins = Math.max(5, Math.round((settings.duration_seconds || 30) / 2));
    const target = 360 * spins + Math.floor(Math.random() * 360);
    const { error } = await sb.from('app_settings').update({
      round_state: 'spinning', spin_started_at: new Date().toISOString(),
      target_rotation: target, winner_numbers: winnerNumbers, winners: [],
      sales_state: 'closed'
    }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= SPIN SETTLE — pay ALL owners of winning numbers ================= */
app.post('/api/spin/settle', async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.round_state !== 'spinning') return res.json({ ok: true });
    const started = new Date(settings.spin_started_at).getTime();
    if (Date.now() - started < settings.duration_seconds * 1000) return res.json({ ok: true });

    const winnerNumbers = settings.winner_numbers || [];
    const { data: tickets } = await sb.from('tickets').select('*').eq('round_number', settings.round_number).in('ticket_number', winnerNumbers);
    const { data: allSold } = await sb.from('tickets').select('*').eq('round_number', settings.round_number).not('user_id', 'is', null);
    const revenue = (allSold || []).length * Number(settings.ticket_price || 0);

    // Group owners by ticket number
    const byNumber = {};
    for (const t of tickets) {
      if (!byNumber[t.ticket_number]) byNumber[t.ticket_number] = [];
      byNumber[t.ticket_number].push(t);
    }
    const winners = [];
    for (let i = 0; i < winnerNumbers.length; i++) {
      const num = winnerNumbers[i];
      const owners = byNumber[num] || [];
      const { amount, percent } = computePrize(i, settings, revenue);
      for (const t of owners) {
        const { data: u } = await sb.from('users').select('*').eq('id', t.user_id).single();
        if (!u) continue;
        await sb.from('users').update({ balance: Number(u.balance) + amount }).eq('id', u.id);
        winners.push({
          place: i + 1, ticket: t.ticket_number, name: u.name,
          public_id: u.public_id, public_code: publicUserId(u.public_id),
          phone_masked: maskPhone(u.phone), phone: u.phone,
          prize: amount, percent
        });
      }
    }
    await sb.from('rounds').insert({
      round_number: settings.round_number, winners,
      sold_tickets: (allSold || []).map(t => ({ number: t.ticket_number, name: t.user_name, phone: t.phone }))
    });
    await sb.from('app_settings').update({ round_state: 'finished', winners }).eq('id', 1);
    if (winners.length) {
      const text = winners.map(w => `🏆 #${w.place} ${escapeTele(w.name)} — #${w.ticket} — ${w.prize} ETB`).join('\n');
      notifyAdmin(`🎡 <b>Round #${settings.round_number} Finished</b>\n\n${text}`);
      notifyChannel(`🎡 <b>Round #${settings.round_number} Winners!</b>\n\n${text}`);
    }
    res.json({ ok: true, winners });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/auto-check', async (req, res) => {
  try {
    const settings = await getSettings();
    const now = Date.now();
    if (settings.sales_state === 'open' && settings.sales_started_at) {
      const expire = new Date(settings.sales_started_at).getTime() + (settings.sales_duration * 60 * 1000);
      if (now >= expire && settings.round_state !== 'spinning') {
        const { data: sold } = await sb.from('tickets').select('*').eq('round_number', settings.round_number).not('user_id', 'is', null);
        if (sold && sold.length) {
          const uniqueSold = [...new Set(sold.map(t => t.ticket_number))];
          const shuffled = uniqueSold.sort(() => Math.random() - 0.5);
          const winnerNumbers = shuffled.slice(0, Math.min(settings.winner_count, shuffled.length));
          const spins = Math.max(5, Math.round((settings.duration_seconds || 30) / 2));
          const target = 360 * spins + Math.floor(Math.random() * 360);
          await sb.from('app_settings').update({
            round_state: 'spinning', spin_started_at: new Date().toISOString(),
            target_rotation: target, winner_numbers: winnerNumbers, winners: [],
            sales_state: 'closed'
          }).eq('id', 1);
          return res.json({ ok: true, action: 'auto-spin' });
        }
      }
    }
    if (settings.round_state === 'spinning' && settings.spin_started_at) {
      const expire = new Date(settings.spin_started_at).getTime() + (settings.duration_seconds * 1000) + 500;
      if (now >= expire) {
        await fetch(`${req.protocol}://${req.get('host')}/api/spin/settle`, { method: 'POST' });
        return res.json({ ok: true, action: 'auto-settle-wheel' });
      }
    }
    const s = await getNbSettings();
    if (s.sales_state === 'open' && s.sales_started_at) {
      const expire = new Date(s.sales_started_at).getTime() + (s.round_duration_minutes * 60 * 1000);
      if (now >= expire && s.round_state !== 'drawing') {
        const tickets = await getNbTickets(s.round_number);
        if (tickets.some(t => t.user_id)) {
          const all = Array.from({ length: s.total_numbers }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
          const winning = all.slice(0, s.drawn_count);
          await sb.from('nb_settings').update({
            round_state: 'drawing', sales_state: 'closed',
            drawing_started_at: new Date().toISOString(),
            winning_numbers: winning, winners: []
          }).eq('id', 1);
          return res.json({ ok: true, action: 'auto-draw-nb' });
        }
      }
    }
    if (s.round_state === 'drawing' && s.drawing_started_at) {
      const required = (s.drawn_count * s.draw_delay_seconds * 1000) + 1500;
      if (now >= new Date(s.drawing_started_at).getTime() + required) {
        await fetch(`${req.protocol}://${req.get('host')}/api/nb/settle`, { method: 'POST' });
        return res.json({ ok: true, action: 'auto-settle-nb' });
      }
    }
    res.json({ ok: true, action: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/round/reset', auth, adminOnly, async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.round_state === 'spinning') return res.status(400).json({ error: 'Wait for wheel' });
    const nextRound = settings.round_number + 1;
    const rows = Array.from({ length: settings.ticket_count }, (_, i) => ({ ticket_number: i + 1, round_number: nextRound }));
    await sb.from('tickets').insert(rows);
    await sb.from('app_settings').update({
      round_number: nextRound, round_state: 'idle', spin_started_at: null,
      target_rotation: 0, winner_numbers: [], winners: [],
      sales_state: 'idle', sales_started_at: null
    }).eq('id', 1);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rounds', auth, async (req, res) => {
  const { data, error } = await sb.from('rounds').select('*').order('id', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rounds: data });
});

app.post('/api/user/deposits', auth, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Users only' });
    const { method, amount, transactionId } = req.body;
    if (!method || !amount || !transactionId) return res.status(400).json({ error: 'All fields required' });
    if (!['cbe','boa'].includes(String(method).toLowerCase())) return res.status(400).json({ error: 'Invalid method' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const { data: user } = await sb.from('users').select('name,phone').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { error } = await sb.from('deposits').insert({
      user_id: req.user.id, user_name: user.name, phone: user.phone,
      method: String(method).toLowerCase(), amount: amt,
      transaction_id: String(transactionId).trim(), status: 'pending'
    });
    if (error) return res.status(500).json({ error: error.message });
    notifyAdmin(`💰 <b>Deposit</b>\n${escapeTele(user.name)}\n${amt} ETB`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/user/deposits', auth, async (req, res) => {
  if (req.user.role !== 'user') return res.json({ deposits: [] });
  const { data, error } = await sb.from('deposits').select('*').eq('user_id', req.user.id).order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deposits: data || [] });
});
app.post('/api/user/withdrawals', auth, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Users only' });
    const { method, amount, accountNumber } = req.body;
    if (!method || !amount || !accountNumber) return res.status(400).json({ error: 'All fields required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const { data: user } = await sb.from('users').select('name,phone,balance').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (Number(user.balance) < amt) return res.status(400).json({ error: 'Insufficient balance' });
    const nb = Number(user.balance) - amt;
    await sb.from('users').update({ balance: nb }).eq('id', req.user.id);
    const { error } = await sb.from('withdrawals').insert({
      user_id: req.user.id, user_name: user.name, phone: user.phone,
      method: String(method).toLowerCase(), amount: amt,
      account_number: String(accountNumber).trim(), status: 'pending'
    });
    if (error) { await sb.from('users').update({ balance: user.balance }).eq('id', req.user.id); return res.status(500).json({ error: error.message }); }
    notifyAdmin(`💸 <b>Withdrawal</b>\n${escapeTele(user.name)}\n${amt} ETB`);
    res.json({ ok: true, newBalance: nb });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/user/withdrawals', auth, async (req, res) => {
  if (req.user.role !== 'user') return res.json({ withdrawals: [] });
  const { data, error } = await sb.from('withdrawals').select('*').eq('user_id', req.user.id).order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data || [] });
});
app.get('/api/admin/deposits', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb.from('deposits').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deposits: data || [] });
});
app.post('/api/admin/deposits/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, comment } = req.body;
    if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const { data: dep } = await sb.from('deposits').select('*').eq('id', id).single();
    if (!dep) return res.status(404).json({ error: 'Not found' });
    if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    if (action === 'approve') {
      const { data: u } = await sb.from('users').select('balance').eq('id', dep.user_id).single();
      if (u) await sb.from('users').update({ balance: Number(u.balance) + Number(dep.amount) }).eq('id', dep.user_id);
    }
    await sb.from('deposits').update({ status: action === 'approve' ? 'approved' : 'rejected', comment: comment || '' }).eq('id', id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb.from('withdrawals').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data || [] });
});
app.post('/api/admin/withdrawals/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, comment } = req.body;
    if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const { data: w } = await sb.from('withdrawals').select('*').eq('id', id).single();
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    if (action === 'reject') {
      const { data: u } = await sb.from('users').select('balance').eq('id', w.user_id).single();
      if (u) await sb.from('users').update({ balance: Number(u.balance) + Number(w.amount) }).eq('id', w.user_id);
    }
    await sb.from('withdrawals').update({ status: action === 'approve' ? 'approved' : 'rejected', comment: comment || '' }).eq('id', id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= WHEEL BUY — freely re-buy sold tickets ================= */
app.post('/api/user/tickets/buy', auth, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Users only' });
    const { numbers, useFreeTicket } = req.body;
    if (!numbers?.length) return res.status(400).json({ error: 'Select at least one' });
    const settings = await getSettings();
    if (settings.sales_state !== 'open') return res.status(400).json({ error: 'Sales are not open' });
    const { data: user } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    let usedFree = false, cost = 0;
    if (useFreeTicket) {
      if ((user.free_tickets || 0) < 1) return res.status(400).json({ error: 'No free tickets' });
      if (numbers.length > 1) return res.status(400).json({ error: 'Free ticket only for 1' });
      usedFree = true;
    } else {
      cost = Number(settings.ticket_price) * numbers.length;
      if (Number(user.balance) < cost) return res.status(400).json({ error: 'Insufficient balance' });
    }
    const upd = {};
    if (usedFree) upd.free_tickets = (user.free_tickets || 0) - 1;
    else upd.balance = Number(user.balance) - cost;
    if (!user.has_bought_ticket) upd.has_bought_ticket = true;
    await sb.from('users').update(upd).eq('id', user.id);

    const now = new Date().toISOString();
    for (const n of numbers) {
      // Always insert a new row so sold tickets can be re-bought by anyone
      await sb.from('tickets').insert({
        ticket_number: n, user_id: user.id, user_name: user.name,
        phone: user.phone, sold_date: now, round_number: settings.round_number,
        used_free_ticket: usedFree
      });
    }
    res.json({ ok: true, cost, usedFree, receipt_ref: generateTicketRef() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= NB ================= */
function nbPublicSettings(s) {
  return {
    total_numbers: s.total_numbers, drawn_count: s.drawn_count,
    tickets_per_purchase: s.tickets_per_purchase,
    price_per_purchase: Number(s.price_per_purchase),
    draw_delay_seconds: s.draw_delay_seconds,
    round_duration_minutes: s.round_duration_minutes,
    winner_count: s.winner_count, prizes: s.prizes,
    prize_percents: s.prize_percents || [],
    use_percent_prizes: !!s.use_percent_prizes,
    sales_state: s.sales_state, round_state: s.round_state,
    round_number: s.round_number,
    sales_started_at: s.sales_started_at,
    drawing_started_at: s.drawing_started_at,
    winning_numbers: s.winning_numbers, winners: s.winners
  };
}
app.get('/api/nb/config', (req, res) => {
  getNbSettings().then(s => res.json(nbPublicSettings(s))).catch(e => res.status(500).json({ error: e.message }));
});
app.get('/api/nb/state', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    const tickets = await getNbTickets(s.round_number);
    const soldCount = tickets.filter(t => t.user_id).length;
    let myTickets = [];
    if (req.user.role !== 'admin') {
      myTickets = tickets.filter(t => String(t.user_id) === String(req.user.id)).map(t => ({ number: t.number, is_free: t.is_free }));
    }
    const enriched = (s.winners || []).map(w => ({
      ...w, public_code: w.public_code || publicUserId(w.public_id),
      phone_masked: w.phone_masked || maskPhone(w.phone)
    }));
    res.json({
      settings: { ...nbPublicSettings(s), winners: enriched },
      sold_count: soldCount,
      tickets: tickets.map(t => ({ number: t.number, user_id: t.user_id, user_name: t.user_name })),
      my_tickets: myTickets
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/nb/buy', auth, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Users only' });
    const { numbers } = req.body;
    if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'Select numbers' });
    const s = await getNbSettings();
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'Sales are not open' });
    if (numbers.length !== Number(s.tickets_per_purchase)) return res.status(400).json({ error: `Pick exactly ${s.tickets_per_purchase}` });
    const bad = numbers.find(n => !Number.isInteger(n) || n < 1 || n > s.total_numbers);
    if (bad !== undefined) return res.status(400).json({ error: 'Invalid number' });
    if (new Set(numbers).size !== numbers.length) return res.status(400).json({ error: 'Numbers must be unique' });
    const { data: user } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const price = Number(s.price_per_purchase);
    if (Number(user.balance) < price) return res.status(400).json({ error: 'Insufficient balance' });

    const batchId = crypto.randomUUID();
    const rows = numbers.map(n => ({
      round_number: s.round_number, number: n,
      user_id: user.id, user_name: user.name, phone: user.phone,
      batch_id: batchId, is_free: false
    }));
    const { error } = await sb.from('nb_tickets').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
    await sb.from('users').update({ balance: Number(user.balance) - price }).eq('id', user.id);
    res.json({ ok: true, cost: price, numbers, receipt_ref: generateTicketRef() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/nb/my-tickets', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.json({ tickets: [] });
    const s = await getNbSettings();
    const { data } = await sb.from('nb_tickets').select('*').eq('round_number', s.round_number).eq('user_id', req.user.id).order('number');
    res.json({ tickets: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/nb/rounds', auth, async (req, res) => {
  try {
    const { data, error } = await sb.from('nb_rounds').select('*').order('id', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rounds: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/settings', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body;
    const upd = {};
    if (b.total_numbers !== undefined) upd.total_numbers = Math.min(200, Math.max(10, Number(b.total_numbers) || 80));
    if (b.drawn_count !== undefined) upd.drawn_count = Math.min(50, Math.max(1, Number(b.drawn_count) || 20));
    if (b.tickets_per_purchase !== undefined) upd.tickets_per_purchase = Math.min(20, Math.max(1, Number(b.tickets_per_purchase) || 3));
    if (b.price_per_purchase !== undefined) upd.price_per_purchase = Math.max(0, Number(b.price_per_purchase) || 0);
    if (b.draw_delay_seconds !== undefined) upd.draw_delay_seconds = Math.min(30, Math.max(1, Number(b.draw_delay_seconds) || 2));
    if (b.round_duration_minutes !== undefined) upd.round_duration_minutes = Math.min(120, Math.max(1, Number(b.round_duration_minutes) || 5));
    if (b.winner_count !== undefined) upd.winner_count = Math.min(20, Math.max(1, Number(b.winner_count) || 3));
    if (Array.isArray(b.prizes)) upd.prizes = b.prizes.map(p => Math.max(0, Number(p) || 0));
    if (Array.isArray(b.prize_percents)) upd.prize_percents = b.prize_percents.map(p => Math.max(0, Number(p) || 0));
    if (b.use_percent_prizes !== undefined) upd.use_percent_prizes = !!b.use_percent_prizes;
    const { error } = await sb.from('nb_settings').update(upd).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/start-sales', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.sales_state === 'open') return res.status(400).json({ error: 'Sales already open' });
    if (s.round_state === 'drawing') return res.status(400).json({ error: 'Drawing in progress' });
    const { error } = await sb.from('nb_settings').update({ sales_state: 'open', sales_started_at: new Date().toISOString() }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    notifyChannel(`🎰 <b>NB Sales Open!</b> Round #${s.round_number}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/close-sales', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await sb.from('nb_settings').update({ sales_state: 'closed' }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/draw', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state === 'drawing') return res.status(400).json({ error: 'Already drawing' });
    const tickets = await getNbTickets(s.round_number);
    if (!tickets.some(t => t.user_id)) return res.status(400).json({ error: 'No tickets sold yet' });
    const all = Array.from({ length: s.total_numbers }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const winning = all.slice(0, s.drawn_count);
    const { error } = await sb.from('nb_settings').update({
      round_state: 'drawing', sales_state: 'closed',
      drawing_started_at: new Date().toISOString(),
      winning_numbers: winning, winners: []
    }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    notifyChannel(`🎰 <b>NB Drawing!</b> Round #${s.round_number}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/new-round', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state === 'drawing') return res.status(400).json({ error: 'Wait for draw' });
    const nextRound = s.round_number + 1;
    await sb.from('nb_settings').update({
      round_number: nextRound, round_state: 'idle', sales_state: 'idle',
      sales_started_at: null, drawing_started_at: null,
      winning_numbers: [], winners: []
    }).eq('id', 1);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers } = req.body;
    if (!name || !phone || !Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'Missing fields' });
    const s = await getNbSettings();
    if (numbers.length !== Number(s.tickets_per_purchase)) return res.status(400).json({ error: `Pick exactly ${s.tickets_per_purchase}` });
    if (new Set(numbers).size !== numbers.length) return res.status(400).json({ error: 'Numbers must be unique' });
    const bad = numbers.find(n => !Number.isInteger(n) || n < 1 || n > s.total_numbers);
    if (bad !== undefined) return res.status(400).json({ error: 'Invalid number' });
    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    if (!user) {
      if (!password) return res.status(400).json({ error: 'Password needed for new user' });
      const hash = await bcrypt.hash(String(password).trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({
        name: cleanName, phone: cleanPhone, password_hash: hash,
        password_plain: String(password).trim(), role: 'user',
        balance: Math.max(0, Number(balance) || 0),
        referral_code: newCode, banned: false
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      if (nb < 0) return res.status(400).json({ error: 'Balance cannot be negative' });
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
      user.name = cleanName; user.balance = nb;
    }
    const batchId = crypto.randomUUID();
    const rows = numbers.map(n => ({
      round_number: s.round_number, number: n,
      user_id: user.id, user_name: user.name, phone: user.phone,
      batch_id: batchId, is_free: true
    }));
    const { error } = await sb.from('nb_tickets').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, user: { ...user, public_code: publicUserId(user.public_id) }, numbers, receipt_ref: generateTicketRef() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/settle', async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state !== 'drawing') return res.json({ ok: true });
    const started = new Date(s.drawing_started_at).getTime();
    const required = (s.drawn_count * s.draw_delay_seconds * 1000) + 1500;
    if (Date.now() - started < required) return res.json({ ok: true });

    const winning = s.winning_numbers || [];
    const tickets = await getNbTickets(s.round_number);
    const tpp = Number(s.tickets_per_purchase) || 3;

    const byUser = {};
    for (const t of tickets) {
      if (!t.user_id) continue;
      if (!byUser[t.user_id]) byUser[t.user_id] = { user_id: t.user_id, name: t.user_name, phone: t.phone, numbers: [] };
      byUser[t.user_id].numbers.push(t.number);
    }
    const sigToUsers = {};
    for (const uid in byUser) {
      const nums = [...new Set(byUser[uid].numbers)].sort((a, b) => a - b);
      const sig = nums.join(',');
      if (!sigToUsers[sig]) sigToUsers[sig] = [];
      sigToUsers[sig].push(uid);
      byUser[uid].sortedNumbers = nums;
    }
    const disqualified = new Set();
    for (const sig in sigToUsers) {
      if (sigToUsers[sig].length > 1) sigToUsers[sig].forEach(u => disqualified.add(u));
    }
    const ranked = [];
    for (const uid in byUser) {
      const u = byUser[uid];
      if (disqualified.has(u.user_id)) { console.log('⚠ Duplicate set DQ:', u.name); continue; }
      const matched = u.sortedNumbers.filter(n => winning.includes(n));
      ranked.push({ user_id: u.user_id, name: u.name, phone: u.phone, matches: matched.length, matched_numbers: matched });
    }
    const revenue = tickets.filter(t => t.user_id).length * Number(s.price_per_purchase || 0);
    const wanted = Math.max(1, Number(s.winner_count) || 1);
    const winners = [];
    const used = new Set();
    for (let place = 1; place <= wanted; place++) {
      const need = tpp - (place - 1);
      const pool = ranked.filter(u => !used.has(u.user_id) && u.matches === need);
      if (!pool.length) continue;
      pool.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      const ch = pool[0];
      used.add(ch.user_id);
      let prize;
      if (s.use_percent_prizes) {
        const pcts = Array.isArray(s.prize_percents) ? s.prize_percents : [];
        const pct = pcts[place - 1] !== undefined ? Number(pcts[place - 1]) : 0;
        prize = Math.round(revenue * pct / 100);
      } else {
        const fixes = Array.isArray(s.prizes) ? s.prizes : [];
        prize = Number(fixes[place - 1] ?? 0);
      }
      const { data: dbU } = await sb.from('users').select('balance,public_id').eq('id', ch.user_id).single();
      winners.push({
        place, name: ch.name,
        public_id: dbU?.public_id ?? null,
        public_code: publicUserId(dbU?.public_id),
        phone: ch.phone, phone_masked: maskPhone(ch.phone),
        matches: ch.matches, shown_numbers: ch.matched_numbers.slice(0, ch.matches),
        prize, percent: s.use_percent_prizes ? (s.prize_percents || [])[place - 1] : null
      });
      if (prize > 0 && dbU) await sb.from('users').update({ balance: Number(dbU.balance) + prize }).eq('id', ch.user_id);
    }
    await sb.from('nb_rounds').insert({
      round_number: s.round_number, winning_numbers: winning, winners,
      sold_tickets: tickets.filter(t => t.user_id).map(t => ({ number: t.number, name: t.user_name, phone: t.phone }))
    });
    await sb.from('nb_settings').update({ round_state: 'finished', winners }).eq('id', 1);
    if (winners.length) {
      const txt = winners.map(w => `🏆 #${w.place} ${escapeTele(w.name)} — ${w.matches} matches — ${w.prize} ETB`).join('\n');
      notifyAdmin(`🎰 <b>NB Round #${s.round_number}</b>\n\n${txt}`);
      notifyChannel(`🎰 <b>NB Winners!</b>\n\n${txt}`);
    }
    res.json({ ok: true, winners, disqualified: disqualified.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', auth, async (req, res) => {
  try {
    if (!groq) return res.status(503).json({ error: 'AI not configured' });
    const { message, history } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const context = req.user.role === 'admin' ? 'ADMIN MODE. Reply short.' : 'USER SUPPORT. Reply short.';
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [
        { role: 'system', content: context },
        ...(Array.isArray(history) ? history.slice(-6) : []),
        { role: 'user', content: message }
      ],
      temperature: 0.6, max_tokens: 400
    });
    res.json({ reply: completion.choices?.[0]?.message?.content || 'No response', role: req.user.role });
  } catch (e) { res.status(500).json({ error: 'AI failed' }); }
});
app.get('/api/admin/insights', auth, adminOnly, async (req, res) => {
  try {
    if (!groq) return res.status(503).json({ error: 'AI not configured' });
    const settings = await getSettings();
    const { data: users } = await sb.from('users').select('*').eq('role', 'user');
    const { data: tickets } = await sb.from('tickets').select('*').eq('round_number', settings.round_number);
    const sold = (tickets || []).filter(t => t.user_id).length;
    const prompt = `Short admin report.\nUsers: ${(users || []).length}, Sold: ${sold}/${settings.ticket_count}.\nUnder 150 words.`;
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 400
    });
    res.json({ insight: completion.choices?.[0]?.message?.content || 'No insight.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Lucky Wheel running on http://localhost:${PORT}`));
export default app;