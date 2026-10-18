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
app.use(express.json({ limit: '10mb' })); // Raised for base64 screenshots
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const sb = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

const JWT_SECRET       = process.env.JWT_SECRET || 'change-me';
const ADMIN_RESET_CODE = process.env.ADMIN_RESET_CODE || '100510';
const OWNER_PHONE      = process.env.OWNER_PHONE || '0945757361';

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

function generateUniqueId(prefix) {
  return prefix + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

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
    if (cleanPhone === OWNER_PHONE) return res.status(400).json({ error: 'This phone number is reserved' });
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

/* ================= VERIFY TICKET ================= */
app.post('/api/verify-ticket', auth, async (req, res) => {
  try {
    const { game, ticketNumber, phone, printerCode } = req.body;

    if (typeof ticketNumber === 'string' && /^[A-Z]{2}-[A-F0-9]{6}$/i.test(ticketNumber.trim())) {
      const batchId = ticketNumber.trim().toUpperCase();

      if (batchId.startsWith('LW-')) {
        const { data: rows } = await sb.from('tickets').select('*').eq('batch_id', batchId);
        if (!rows || !rows.length) return res.status(404).json({ error: 'No Wheel batch found with that ID' });
        const settings = await getSettings();
        const firstTicket = rows[0];
        const isWinner = Array.isArray(settings.winner_numbers) && rows.some(r => settings.winner_numbers.includes(r.ticket_number));
        let prize = null, percent = null;
        if (isWinner && Array.isArray(settings.winners)) {
          const winnerObj = settings.winners.find(w => rows.some(r => r.ticket_number === w.ticket));
          if (winnerObj) { prize = winnerObj.prize; percent = winnerObj.percent; }
        }
        return res.json({
          ok: true, game: 'Lucky Wheel',
          number: rows.map(r => r.ticket_number).join(' '),
          round: firstTicket.round_number,
          owner_name: firstTicket.user_name || '—',
          owner_phone: firstTicket.phone || '—',
          public_code: '—',
          sold_date: firstTicket.sold_date,
          printer_code: batchId,
          is_winner: isWinner,
          round_finished: settings.round_state === 'finished',
          prize, percent
        });
      }

      if (batchId.startsWith('NB-')) {
        const { data: rows } = await sb.from('nb_tickets').select('*').eq('batch_id', batchId);
        if (!rows || !rows.length) return res.status(404).json({ error: 'No NB batch found with that ID' });
        const s = await getNbSettings();
        const firstUser = rows[0];
        const { data: dbUser } = await sb.from('users').select('name,phone,public_id').eq('id', firstUser.user_id).maybeSingle();
        let isWinner = false, prize = null, percent = null;
        if (s.round_state === 'finished' && Array.isArray(s.winners) && dbUser?.public_id) {
          for (const w of s.winners) {
            if (w.public_id && w.public_id === dbUser.public_id) { isWinner = true; prize = w.prize; percent = w.percent; break; }
          }
        }
        return res.json({
          ok: true, game: 'Number Betting',
          number: rows.map(r => r.number).join(' '),
          round: firstUser.round_number,
          owner_name: dbUser?.name || firstUser.user_name || '—',
          owner_phone: dbUser?.phone || firstUser.phone || '—',
          public_code: publicUserId(dbUser?.public_id),
          sold_date: firstUser.sold_date,
          printer_code: batchId,
          is_winner: isWinner,
          round_finished: s.round_state === 'finished',
          prize, percent,
          matches: (s.winning_numbers || []).filter(n => rows.some(r => r.number === n)).length
        });
      }
    }

    if (printerCode && String(printerCode).trim()) {
      const code = String(printerCode).trim().toUpperCase();
      let { data: row } = await sb.from('tickets').select('*').eq('printer_code', code).maybeSingle();
      if (row) return res.json(await buildWheelVerify(row));
      const { data: nbRow } = await sb.from('nb_tickets').select('*').eq('printer_code', code).maybeSingle();
      if (nbRow) return res.json(await buildNbVerify(nbRow));
      return res.status(404).json({ error: 'No ticket found for that printer code' });
    }

    if (!ticketNumber) return res.status(400).json({ error: 'Ticket number required' });
    const num = Number(ticketNumber);
    if (!Number.isFinite(num)) return res.status(400).json({ error: 'Invalid ticket number' });

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
    printer_code: t.batch_id || t.printer_code,
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
    printer_code: t.batch_id || t.printer_code,
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

    let batchId = '—';

    if (game === 'nb') {
      const { data } = await sb.from('nb_tickets').select('batch_id, number').eq('round_number', round).in('number', tickets);
      if (data && data.length) batchId = data[0].batch_id;
    } else {
      const { data } = await sb.from('tickets').select('batch_id, ticket_number').eq('round_number', round).in('ticket_number', tickets);
      if (data && data.length) batchId = data[0].batch_id;
    }

    const enriched = tickets.map(t => {
      const num = typeof t === 'object' ? t.number : t;
      return { number: num };
    });

    res.json({
      ok: true,
      game: game === 'nb' ? 'Number Betting' : 'Lucky Wheel',
      round, tickets: enriched, owner,
      ref: batchId,
      date: new Date().toISOString(),
      price: game === 'nb' ? Number(settings.price_per_purchase) : Number(settings.ticket_price)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= ADMIN USERS ================= */
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

    const { data: target } = await sb.from('users').select('phone, role').eq('id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.phone === OWNER_PHONE) return res.status(403).json({ error: 'Owner password can only be changed with the secret code from Settings.' });

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
    const { data: target } = await sb.from('users').select('phone, role').eq('id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.phone === OWNER_PHONE) return res.status(403).json({ error: 'The owner can never be banned.' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be banned.' });
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

/* ================= WHEEL ASSIGN ================= */
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

    const batchId = generateUniqueId('LW');
    const now = new Date().toISOString();
    for (const n of numbers) {
      await sb.from('tickets').insert({
        ticket_number: n, user_id: user.id, user_name: cleanName,
        phone: cleanPhone, sold_date: now, round_number: settings.round_number,
        used_free_ticket: usedFree, batch_id: batchId
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

/* ================= ADMIN SETTINGS ================= */
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

/* ================= NB START SALES ================= */
app.post('/api/admin/nb/start-sales', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.sales_state === 'open') return res.status(400).json({ error: 'NB sales already open' });
    if (s.round_state === 'drawing') return res.status(400).json({ error: 'NB drawing in progress' });
    const { error } = await sb.from('nb_settings').update({
      sales_state: 'open',
      sales_started_at: new Date().toISOString()
    }).eq('id', 1);
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

/* ================= DEPOSITS (with screenshot + txn id) ================= */
app.get('/api/admin/deposits', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb
    .from('deposits')
    .select('id,user_id,user_name,phone,amount,method,transaction_id,screenshot,status,comment,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const userIds = [...new Set((data || []).map(d => d.user_id).filter(Boolean))];
  let map = {};
  if (userIds.length) {
    const { data: users } = await sb.from('users').select('id,public_id').in('id', userIds);
    (users || []).forEach(u => { map[u.id] = u.public_id; });
  }
  const enriched = (data || []).map(d => ({ ...d, public_code: publicUserId(map[d.user_id]) }));
  res.json({ deposits: enriched });
});

app.get('/api/user/deposits', auth, async (req, res) => {
  const { data, error } = await sb
    .from('deposits')
    .select('id,amount,method,transaction_id,screenshot,status,comment,created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deposits: data || [] });
});

app.post('/api/user/deposits', auth, async (req, res) => {
  try {
    const { method, amount, transactionId, screenshot } = req.body;
    const amt = Number(amount);
    if (!method || !amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!transactionId || !String(transactionId).trim()) return res.status(400).json({ error: 'Transaction ID required' });

    const { data: me } = await sb.from('users').select('name,phone').eq('id', req.user.id).single();
    const { error } = await sb.from('deposits').insert({
      user_id: req.user.id,
      user_name: me?.name || '',
      phone: me?.phone || '',
      amount: amt,
      method,
      transaction_id: String(transactionId).trim(),
      screenshot: screenshot || null,
      status: 'pending'
    });
    if (error) return res.status(500).json({ error: error.message });
    notifyAdmin(`💰 <b>New Deposit</b>\nUser: ${escapeTele(me?.name)}\nPhone: ${escapeTele(me?.phone)}\nAmount: ${amt} ETB\nTxn: ${escapeTele(transactionId)}\nScreenshot: ${screenshot ? 'uploaded' : 'none'}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const { action, comment } = req.body;
    const id = Number(req.params.id);
    const { data: dep } = await sb.from('deposits').select('*').eq('id', id).single();
    if (!dep) return res.status(404).json({ error: 'Deposit not found' });
    if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      const { data: u } = await sb.from('users').select('balance').eq('id', dep.user_id).single();
      const nb = Number(u?.balance || 0) + Number(dep.amount);
      await sb.from('users').update({ balance: nb }).eq('id', dep.user_id);
      await sb.from('deposits').update({ status: 'approved', comment: comment || '' }).eq('id', id);
    } else {
      await sb.from('deposits').update({ status: 'rejected', comment: comment || '' }).eq('id', id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= WITHDRAWALS ================= */
app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  const { data, error } = await sb
    .from('withdrawals')
    .select('id,user_id,user_name,phone,amount,method,account_number,status,comment,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data || [] });
});

app.get('/api/user/withdrawals', auth, async (req, res) => {
  const { data, error } = await sb
    .from('withdrawals')
    .select('id,amount,method,account_number,status,comment,created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data || [] });
});

app.post('/api/user/withdrawals', auth, async (req, res) => {
  try {
    const { method, amount, accountNumber } = req.body;
    const amt = Number(amount);
    if (!method || !amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!accountNumber) return res.status(400).json({ error: 'Account required' });
    const { data: me } = await sb.from('users').select('balance,name,phone').eq('id', req.user.id).single();
    if (!me || Number(me.balance) < amt) return res.status(400).json({ error: 'Insufficient balance' });
    await sb.from('users').update({ balance: Number(me.balance) - amt }).eq('id', req.user.id);
    const { error } = await sb.from('withdrawals').insert({
      user_id: req.user.id,
      user_name: me.name,
      phone: me.phone,
      amount: amt,
      method,
      account_number: accountNumber,
      status: 'pending'
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const { action, comment } = req.body;
    const id = Number(req.params.id);
    const { data: w } = await sb.from('withdrawals').select('*').eq('id', id).single();
    if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      await sb.from('withdrawals').update({ status: 'approved', comment: comment || '' }).eq('id', id);
    } else {
      const { data: u } = await sb.from('users').select('balance').eq('id', w.user_id).single();
      await sb.from('users').update({ balance: Number(u?.balance || 0) + Number(w.amount) }).eq('id', w.user_id);
      await sb.from('withdrawals').update({ status: 'rejected', comment: comment || '' }).eq('id', id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= WHEEL TICKET BUY ================= */
app.post('/api/user/tickets/buy', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot buy' });
    const { numbers, useFreeTicket } = req.body;
    if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'No numbers selected' });

    const settings = await getSettings();
    if (settings.sales_state !== 'open') return res.status(400).json({ error: 'Sales are closed' });

    const { data: me } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!me || me.banned) return res.status(403).json({ error: 'Account not allowed' });

    const price = Number(settings.ticket_price) || 0;
    const free = !!useFreeTicket;
    if (free) {
      if ((me.free_tickets || 0) < 1) return res.status(400).json({ error: 'No free tickets' });
      if (numbers.length !== 1) return res.status(400).json({ error: 'Free ticket = 1 only' });
    }
    const cost = free ? 0 : price * numbers.length;
    if (Number(me.balance) < cost) return res.status(400).json({ error: 'Insufficient balance' });

    const { data: sold } = await sb.from('tickets').select('ticket_number')
      .eq('round_number', settings.round_number).in('ticket_number', numbers).not('user_id', 'is', null);
    if (sold && sold.length) return res.status(400).json({ error: 'Some tickets are already sold' });

    const batchId = generateUniqueId('LW');
    const now = new Date().toISOString();
    for (const n of numbers) {
      await sb.from('tickets').update({
        user_id: me.id, user_name: me.name, phone: me.phone,
        sold_date: now, used_free_ticket: free, batch_id: batchId
      }).eq('round_number', settings.round_number).eq('ticket_number', n);
    }

    const upd = { balance: Number(me.balance) - cost };
    if (free) upd.free_tickets = (me.free_tickets || 0) - 1;
    await sb.from('users').update(upd).eq('id', me.id);

    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= NB CORE ================= */
app.get('/api/nb/config', auth, async (req, res) => {
  try { const s = await getNbSettings(); res.json(s); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/state', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    const tickets = await getNbTickets(s.round_number);
    const my = tickets.filter(t => String(t.user_id) === String(req.user.id));
    res.json({
      settings: s,
      tickets,
      my_tickets: my,
      sold_count: tickets.filter(t => t.user_id).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/my-tickets', auth, async (req, res) => {
  try {
    const { data, error } = await sb.from('nb_tickets').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tickets: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/buy', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot buy' });
    const { numbers } = req.body;
    const s = await getNbSettings();
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'NB sales closed' });
    if (!Array.isArray(numbers) || numbers.length !== s.tickets_per_purchase) {
      return res.status(400).json({ error: 'Pick ' + s.tickets_per_purchase + ' numbers' });
    }
    const { data: me } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!me || me.banned) return res.status(403).json({ error: 'Account not allowed' });
    if (Number(me.balance) < Number(s.price_per_purchase)) return res.status(400).json({ error: 'Insufficient balance' });

    const batchId = generateUniqueId('NB');
    const now = new Date().toISOString();
    for (const n of numbers) {
      await sb.from('nb_tickets').insert({
        number: n, user_id: me.id, user_name: me.name, phone: me.phone,
        round_number: s.round_number, sold_date: now, batch_id: batchId, is_free: false
      });
    }
    await sb.from('users').update({ balance: Number(me.balance) - Number(s.price_per_purchase) }).eq('id', me.id);
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================= NB ADMIN ================= */
app.post('/api/admin/nb/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers } = req.body;
    if (!name || !phone || !numbers?.length) return res.status(400).json({ error: 'Missing fields' });
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
    }

    const s = await getNbSettings();
    const batchId = generateUniqueId('NB');
    const now = new Date().toISOString();
    for (const n of numbers) {
      await sb.from('nb_tickets').insert({
        number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone,
        round_number: s.round_number, sold_date: now, batch_id: batchId, is_free: false
      });
    }
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/settings', auth, adminOnly, async (req, res) => {
  try {
    const { total_numbers, drawn_count, tickets_per_purchase, price_per_purchase,
            draw_delay_seconds, round_duration_minutes, duration_minutes,
            winner_count, prize_percents, use_percent_prizes } = req.body;
    const upd = {};
    if (total_numbers !== undefined) upd.total_numbers = Math.max(10, Math.min(200, Number(total_numbers)));
    if (drawn_count !== undefined) upd.drawn_count = Math.max(1, Math.min(50, Number(drawn_count)));
    if (tickets_per_purchase !== undefined) upd.tickets_per_purchase = Math.max(1, Math.min(20, Number(tickets_per_purchase)));
    if (price_per_purchase !== undefined) upd.price_per_purchase = Math.max(0, Number(price_per_purchase));
    if (draw_delay_seconds !== undefined) upd.draw_delay_seconds = Math.max(1, Math.min(30, Number(draw_delay_seconds)));

    const durRaw = round_duration_minutes !== undefined ? round_duration_minutes : duration_minutes;
    if (durRaw !== undefined) upd.round_duration_minutes = Math.max(1, Number(durRaw));

    if (winner_count !== undefined) upd.winner_count = Math.max(1, Math.min(20, Number(winner_count)));
    if (Array.isArray(prize_percents)) upd.prize_percents = prize_percents.map(p => Math.max(0, Number(p) || 0));
    if (use_percent_prizes !== undefined) upd.use_percent_prizes = !!use_percent_prizes;

    if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });

    const { error } = await sb.from('nb_settings').update(upd).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, updated: upd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/draw', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state === 'drawing') return res.status(400).json({ error: 'Already drawing' });
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'Close sales first' });
    const allNums = Array.from({ length: s.total_numbers }, (_, i) => i + 1);
    const shuffled = allNums.sort(() => Math.random() - 0.5);
    const winning = shuffled.slice(0, s.drawn_count);
    const { error } = await sb.from('nb_settings').update({
      round_state: 'drawing',
      drawing_started_at: new Date().toISOString(),
      winning_numbers: winning,
      winners: []
    }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, winning });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/settle', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state !== 'drawing') return res.json({ ok: true, skipped: true });
    const start = new Date(s.drawing_started_at).getTime();
    const totalDur = (s.drawn_count * s.draw_delay_seconds + 2) * 1000;
    if (Date.now() - start < totalDur) return res.json({ ok: true, pending: true });

    const tickets = await getNbTickets(s.round_number);
    const winningSet = new Set(s.winning_numbers || []);
    const byUser = {};
    for (const t of tickets) {
      if (!t.user_id) continue;
      if (!byUser[t.user_id]) byUser[t.user_id] = { user_id: t.user_id, numbers: [], name: t.user_name, phone: t.phone };
      byUser[t.user_id].numbers.push(t.number);
    }

    const revenue = tickets.filter(t => t.user_id).length * Number(s.price_per_purchase);
    const ranked = Object.values(byUser).map(u => {
      const matches = u.numbers.filter(n => winningSet.has(n)).length;
      return { ...u, matches };
    }).filter(u => u.matches > 0).sort((a, b) => b.matches - a.matches);

    const winners = [];
    const usePct = !!s.use_percent_prizes;
    const pcts = Array.isArray(s.prize_percents) ? s.prize_percents : [];
    for (let i = 0; i < Math.min(s.winner_count, ranked.length); i++) {
      const r = ranked[i];
      const { data: dbUser } = await sb.from('users').select('public_id').eq('id', r.user_id).single();
      const pct = usePct ? Number(pcts[i] || 0) : 0;
      const prize = usePct ? Math.round(revenue * pct / 100) : 0;
      winners.push({
        place: i + 1,
        user_id: r.user_id,
        name: r.name,
        phone_masked: maskPhone(r.phone),
        public_id: dbUser?.public_id,
        public_code: publicUserId(dbUser?.public_id),
        matches: r.matches,
        shown_numbers: r.numbers,
        prize, percent: pct
      });
      if (prize > 0) {
        const { data: cur } = await sb.from('users').select('balance').eq('id', r.user_id).single();
        await sb.from('users').update({ balance: Number(cur?.balance || 0) + prize }).eq('id', r.user_id);
      }
    }

    await sb.from('nb_settings').update({ round_state: 'finished', winners }).eq('id', 1);
    notifyChannel(`🎰 <b>NB Round #${s.round_number} Finished!</b>`);
    res.json({ ok: true, winners });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/new-round', auth, adminOnly, async (req, res) => {
  try {
    const s = await getNbSettings();
    const next = Number(s.round_number) + 1;
    const { error } = await sb.from('nb_settings').update({
      round_number: next,
      sales_state: 'idle',
      sales_started_at: null,
      round_state: 'idle',
      drawing_started_at: null,
      winning_numbers: [],
      winners: []
    }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/rounds', auth, async (req, res) => {
  try {
    const { data, error } = await sb.from('nb_rounds').select('*').order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rounds: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rounds', auth, async (req, res) => {
  try {
    const { data, error } = await sb.from('rounds').select('*').order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rounds: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/auto-check', (req, res) => { res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));