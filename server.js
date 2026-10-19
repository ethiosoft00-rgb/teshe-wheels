import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

process.on('uncaughtException', (err) => { console.error('🔥 FATAL ERROR:', err); });
process.on('unhandledRejection', (err) => { console.error('🔥 UNHANDLED PROMISE:', err); });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const sb = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const OWNER_PHONE = process.env.OWNER_PHONE || '0945757361';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY; 

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
  const { count } = await sb.from('tickets').select('*', { count: 'exact', head: true })
    .eq('round_number', data.round_number).not('user_id', 'is', null);
  data.wheel_sold = count || 0;
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
function generateUniqueId(prefix) { return prefix + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function sign(p) { return jwt.sign(p, JWT_SECRET, { expiresIn: '30d' }); }

app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password, referralCode } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Please fill all fields' });
    const cleanName = String(name).trim(); const cleanPhone = String(phone).trim(); const cleanPassword = String(password).trim();
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
      name: cleanName, phone: cleanPhone, password_hash: hash, password_plain: cleanPassword, role: 'user', balance: 0, referral_code: myCode, referred_by: referredBy, banned: false
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, referral_code: myCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    const cleanPhone = String(phone).trim(); const cleanPassword = String(password).trim();
    const { data: user, error } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    if (error) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(401).json({ error: 'Invalid phone number or password' });
    if (user.banned) return res.status(403).json({ error: 'Your account has been banned.' });
    const ok = await bcrypt.compare(cleanPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid phone number or password' });
    const token = sign({ id: user.id, role: user.role, phone: user.phone });
    res.json({ token, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const settings = await getSettings(); const tickets = await getTickets(); let me;
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

app.post('/api/ticket-receipt', auth, async (req, res) => {
  try {
    const { game, round, tickets } = req.body;
    const settings = game === 'nb' ? await getNbSettings() : await getSettings();
    let owner = { name: 'Admin', phone: '-' };
    if (req.user.role !== 'admin') {
      const { data: u } = await sb.from('users').select('name,phone,public_id').eq('id', req.user.id).single();
      if (u) owner = { name: u.name, phone: u.phone, public_code: u.public_id ? 'U' + String(u.public_id).padStart(5, '0') : null };
    }
    let batchId = 'TICKET-' + tickets[0];
    if (game === 'nb') {
      const { data } = await sb.from('nb_tickets').select('batch_id, number').eq('round_number', round).in('number', tickets);
      if (data && data.length && data[0].batch_id) batchId = data[0].batch_id;
    } else {
      const { data } = await sb.from('tickets').select('batch_id, ticket_number').eq('round_number', round).in('ticket_number', tickets);
      if (data && data.length && data[0].batch_id) batchId = data[0].batch_id;
    }
    const enriched = tickets.map(t => ({ number: typeof t === 'object' ? t.number : t, printer_code: batchId }));
    res.json({ ok: true, game: game === 'nb' ? 'Number Betting' : 'Lucky Wheel', round, tickets: enriched, owner, ref: batchId, date: new Date().toISOString(), price: game === 'nb' ? Number(settings.price_per_purchase) : Number(settings.ticket_price) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify-ticket', auth, async (req, res) => {
  try {
    let { printerCode, ticketNumber, unique_id } = req.body;
    let searchNum = String(ticketNumber || unique_id || printerCode || '').trim();
    const originalInput = searchNum;
    if (searchNum.startsWith('TICKET-')) searchNum = searchNum.replace('TICKET-', '');
    if (searchNum.startsWith('NB-')) searchNum = searchNum.replace('NB-', '');

    let ticket = null; let isNb = false;
    let { data: t1 } = await sb.from('tickets').select('*').eq('batch_id', originalInput).limit(1);
    if (!t1 || t1.length === 0) {
        const { data: t1b } = await sb.from('tickets').select('*').eq('ticket_number', searchNum).limit(1);
        if (t1b && t1b.length > 0) t1 = t1b;
    }
    let { data: t2 } = await sb.from('nb_tickets').select('*').eq('batch_id', originalInput).limit(1);
    if (!t2 || t2.length === 0) {
        const { data: t2b } = await sb.from('nb_tickets').select('*').eq('number', searchNum).limit(1);
        if (t2b && t2b.length > 0) t2 = t2b;
    }
    if (t1 && t1.length > 0) { ticket = t1[0]; isNb = false; }
    else if (t2 && t2.length > 0) { ticket = t2[0]; isNb = true; }
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    let roundSettings;
    if (isNb) {
      const { data: s } = await sb.from('nb_settings').select('*').eq('id', 1).single();
      roundSettings = s;
    } else {
      const { data: s } = await sb.from('app_settings').select('*').eq('id', 1).single();
      roundSettings = s;
    }

    let isWinner = false; let prize = 0; let status = 'progress';
    const isCurrentRound = (ticket.round_number === roundSettings.round_number);
    if (isCurrentRound) {
      if (roundSettings.round_state === 'finished') {
        const winningNums = isNb ? (roundSettings.winning_numbers || []) : (roundSettings.winner_numbers || []);
        const winnersList = roundSettings.winners || [];
        const ticketNum = isNb ? ticket.number : ticket.ticket_number;
        if (winningNums.includes(ticketNum)) {
            const winnerObj = winnersList.find(w => w.ticket === ticketNum || (w.shown_numbers || []).includes(ticketNum));
            if (winnerObj) { isWinner = true; prize = winnerObj.prize; status = 'winner'; } else { status = 'not_winner'; }
        } else { status = 'not_winner'; }
      } else { status = 'progress'; }
    } else { status = 'past_round'; }

    res.json({ ok: true, game: isNb ? 'Number Betting' : 'Lucky Wheel', numbers: [isNb ? ticket.number : ticket.ticket_number], unique_id: ticket.batch_id || 'TICKET-' + (isNb ? ticket.number : ticket.ticket_number), round: ticket.round_number, owner_name: ticket.user_name, owner_phone: ticket.phone, sold_date: ticket.sold_date, is_current_round: isCurrentRound, round_finished: isCurrentRound ? roundSettings.round_state === 'finished' : true, is_winner: isWinner, prize: prize, status: status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/config', auth, async (req, res) => { try { const s = await getNbSettings(); res.json(s); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/nb/state', auth, async (req, res) => {
  try {
    const s = await getNbSettings(); const tickets = await getNbTickets(s.round_number);
    const my = tickets.filter(t => String(t.user_id) === String(req.user.id));
    res.json({ settings: s, tickets, my_tickets: my, sold_count: tickets.filter(t => t.user_id).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/nb/my-tickets', auth, async (req, res) => { try { const { data, error } = await sb.from('nb_tickets').select('*').eq('user_id', req.user.id); if (error) return res.status(500).json({ error: error.message }); res.json({ tickets: data || [] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/wheel/my-tickets', auth, async (req, res) => { try { const { data, error } = await sb.from('tickets').select('*').eq('user_id', req.user.id).order('sold_date', { ascending: false }); if (error) return res.status(500).json({ error: error.message }); res.json({ tickets: data || [] }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/user/tickets/buy', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot buy' });
    const { numbers, useFreeTicket } = req.body;
    const s = await getSettings();
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'Sales are closed' });
    if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'Select at least one ticket' });
    const { data: me } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!me || me.banned) return res.status(403).json({ error: 'Account not allowed' });
    const { data: existing } = await sb.from('tickets').select('ticket_number,user_id').eq('round_number', s.round_number).in('ticket_number', numbers);
    const taken = (existing || []).filter(t => t.user_id);
    if (taken.length) return res.status(400).json({ error: 'Some tickets are already sold: ' + taken.map(t => '#' + t.ticket_number).join(', ') });
    let usedFree = false;
    if (useFreeTicket) {
      if ((me.free_tickets || 0) <= 0) return res.status(400).json({ error: 'No free tickets left' });
      if (numbers.length !== 1) return res.status(400).json({ error: 'Free ticket allows only 1 number' });
      usedFree = true;
    }
    const cost = usedFree ? 0 : numbers.length * Number(s.ticket_price);
    if (!usedFree && Number(me.balance) < cost) return res.status(400).json({ error: 'Insufficient balance' });
    const batchId = generateUniqueId('LW'); const now = new Date().toISOString();
    await sb.from('tickets').delete().eq('round_number', s.round_number).in('ticket_number', numbers).is('user_id', null);
    const insertRows = numbers.map(n => ({ ticket_number: n, user_id: me.id, user_name: me.name, phone: me.phone, sold_date: now, round_number: s.round_number, used_free_ticket: usedFree, batch_id: batchId }));
    const { error: insErr } = await sb.from('tickets').insert(insertRows);
    if (insErr) return res.status(500).json({ error: insErr.message });
    const update = { balance: Number(me.balance) - cost, has_bought_ticket: true };
    if (usedFree) update.free_tickets = (me.free_tickets || 0) - 1;
    await sb.from('users').update(update).eq('id', me.id);
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/buy', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot buy' });
    const { numbers } = req.body; const s = await getNbSettings();
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'NB sales are closed' });
    if (!Array.isArray(numbers) || numbers.length !== s.tickets_per_purchase) return res.status(400).json({ error: 'Pick exactly ' + s.tickets_per_purchase + ' numbers' });
    const { data: me } = await sb.from('users').select('*').eq('id', req.user.id).single();
    if (!me || me.banned) return res.status(403).json({ error: 'Account not allowed' });
    if (Number(me.balance) < Number(s.price_per_purchase)) return res.status(400).json({ error: 'Insufficient balance' });
    const batchId = generateUniqueId('NB'); const now = new Date().toISOString();
    const insertRows = numbers.map(n => ({ number: n, user_id: me.id, user_name: me.name, phone: me.phone, round_number: s.round_number, sold_date: now, batch_id: batchId, is_free: false }));
    const { error: insertErr } = await sb.from('nb_tickets').insert(insertRows);
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    await sb.from('users').update({ balance: Number(me.balance) - Number(s.price_per_purchase) }).eq('id', me.id);
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tickets/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers, useFreeTicket } = req.body;
    const cleanName = String(name).trim(); const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    if (!user) {
      const hash = await bcrypt.hash(String(password || '1234').trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({ name: cleanName, phone: cleanPhone, password_hash: hash, password_plain: String(password || '1234').trim(), role: 'user', balance: Math.max(0, Number(balance) || 0), referral_code: newCode, banned: false }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
    }
    const settings = await getSettings();
    let usedFree = false;
    if (useFreeTicket && (user.free_tickets || 0) > 0) {
      await sb.from('users').update({ free_tickets: user.free_tickets - 1 }).eq('id', user.id);
      usedFree = true;
    }
    const batchId = generateUniqueId('LW'); const now = new Date().toISOString();
    await sb.from('tickets').delete().eq('round_number', settings.round_number).in('ticket_number', numbers).is('user_id', null);
    const insertRows = numbers.map(n => ({ ticket_number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone, sold_date: now, round_number: settings.round_number, used_free_ticket: usedFree, batch_id: batchId }));
    const { error } = await sb.from('tickets').insert(insertRows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers } = req.body;
    const cleanName = String(name).trim(); const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();
    if (!user) {
      const hash = await bcrypt.hash(String(password || '1234').trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({ name: cleanName, phone: cleanPhone, password_hash: hash, password_plain: String(password || '1234').trim(), role: 'user', balance: Math.max(0, Number(balance) || 0), referral_code: newCode, banned: false }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
    }
    const s = await getNbSettings(); const batchId = generateUniqueId('NB'); const now = new Date().toISOString();
    const insertRows = numbers.map(n => ({ number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone, round_number: s.round_number, sold_date: now, batch_id: batchId, is_free: false }));
    const { error } = await sb.from('nb_tickets').insert(insertRows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users/full', auth, adminOnly, async (req, res) => {
  try { const { data: users, error } = await sb.from('users').select('*').eq('role', 'user').order('created_at'); if (error) throw error; res.json({ users: users || [] }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/withdrawals', auth, async (req, res) => {
  try { const { data, error } = await sb.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }); if (error) throw error; res.json({ withdrawals: data || [] }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/withdrawals', auth, async (req, res) => {
  try {
    const { method, amount, accountNumber } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!accountNumber) return res.status(400).json({ error: 'Account number required' });
    const { data: me } = await sb.from('users').select('balance').eq('id', req.user.id).single();
    if (!me || Number(me.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const { error } = await sb.from('withdrawals').insert({ user_id: req.user.id, user_name: req.user.phone, phone: req.user.phone, method, amount, account_number: accountNumber, status: 'pending' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/deposits', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await sb.from('deposits').select('*, users(name, phone)').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ deposits: (data || []).map(d => ({ ...d, user_name: d.users?.name || 'Unknown', phone: d.users?.phone || d.phone })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await sb.from('withdrawals').select('*, users(name, phone)').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ withdrawals: (data || []).map(w => ({ ...w, user_name: w.users?.name || 'Unknown', phone: w.users?.phone || w.phone })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const { action } = req.body;
    const { data: w } = await sb.from('withdrawals').select('*').eq('id', req.params.id).single();
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    if (action === 'approve') {
      const { data: user } = await sb.from('users').select('balance').eq('id', w.user_id).single();
      if (Number(user.balance) < Number(w.amount)) return res.status(400).json({ error: 'User has insufficient balance now' });
      await sb.from('users').update({ balance: Number(user.balance) - Number(w.amount) }).eq('id', w.user_id);
      await sb.from('withdrawals').update({ status: 'approved' }).eq('id', w.id);
    } else {
      await sb.from('withdrawals').update({ status: 'rejected' }).eq('id', w.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rounds', auth, async (req, res) => {
  try { const { data, error } = await sb.from('round_history').select('*').eq('game_type', 'wheel').order('created_at', { ascending: false }).limit(50); if (error) throw error; res.json({ rounds: data || [] }); } catch(e) { res.json({ rounds: [] }); }
});
app.get('/api/nb/rounds', auth, async (req, res) => {
  try { const { data, error } = await sb.from('round_history').select('*').eq('game_type', 'nb').order('created_at', { ascending: false }).limit(50); if (error) throw error; res.json({ rounds: data || [] }); } catch(e) { res.json({ rounds: [] }); }
});

// --- WHEEL ADMIN ROUTES ---
app.post('/api/admin/start-sales', auth, adminOnly, async (req, res) => {
  const s = await getSettings();
  if (s.round_state !== 'idle') return res.status(400).json({ error: 'Round not idle' });
  await sb.from('app_settings').update({ sales_state: 'open', sales_started_at: new Date().toISOString() }).eq('id', 1);
  res.json({ ok: true });
});

app.post('/api/admin/close-sales', auth, adminOnly, async (req, res) => {
  await sb.from('app_settings').update({ sales_state: 'closed' }).eq('id', 1);
  res.json({ ok: true });
});

app.post('/api/admin/spin/start', auth, adminOnly, async (req, res) => {
  const s = await getSettings();
  const tickets = await getTickets();
  const sold = tickets.filter(t => t.user_id || t.owner_name || t.phone);
  if (!sold.length) return res.status(400).json({ error: 'No tickets sold yet' });

  const winnersCount = s.winner_count || 1;
  const pcts = s.prize_percents || [];
  const totalSales = sold.length * s.ticket_price;
  const shuffled = sold.sort(() => Math.random() - 0.5);
  const winnersList = [];
  
  for (let i = 0; i < Math.min(winnersCount, sold.length); i++) {
    const t = shuffled[i];
    const pct = pcts[i] !== undefined ? pcts[i] : (i === 0 ? 50 : i === 1 ? 30 : 10);
    const prize = (totalSales * pct) / 100;
    winnersList.push({ place: i + 1, name: t.user_name, phone_masked: t.phone ? t.phone.slice(0, 3) + '***' + t.phone.slice(-3) : '—', public_code: 'U' + String(t.user_id).padStart(5, '0'), ticket: t.ticket_number, prize: prize });
    if (prize > 0) {
      const { data: user } = await sb.from('users').select('balance').eq('id', t.user_id).single();
      if (user) await sb.from('users').update({ balance: Number(user.balance) + prize }).eq('id', t.user_id);
    }
  }

  const firstWinnerTicket = winnersList[0].ticket;
  const winnerIndex = sold.findIndex(t => t.ticket_number === firstWinnerTicket);
  const anglePerSection = 360 / sold.length;
  const targetRotation = 360 - (winnerIndex * anglePerSection) - (anglePerSection / 2);

  await sb.from('app_settings').update({ round_state: 'spinning', spin_started_at: new Date().toISOString(), target_rotation: targetRotation, winner_numbers: winnersList.map(w => w.ticket), winners: winnersList }).eq('id', 1);
  await sb.from('round_history').insert({ game_type: 'wheel', round_number: s.round_number, winners: winnersList });
  res.json({ ok: true });
});

app.post('/api/spin/settle', auth, async (req, res) => {
  const s = await getSettings();
  if (s.round_state === 'spinning') {
     await sb.from('app_settings').update({ round_state: 'finished' }).eq('id', 1);
  }
  res.json({ ok: true });
});

app.post('/api/admin/round/reset', auth, adminOnly, async (req, res) => {
  const s = await getSettings();
  await sb.from('tickets').delete().eq('round_number', s.round_number);
  await sb.from('app_settings').update({ round_number: Number(s.round_number) + 1, sales_state: 'idle', round_state: 'idle', winner_numbers: [], winners: [], target_rotation: 0, spin_started_at: null, sales_started_at: null }).eq('id', 1);
  res.json({ ok: true });
});

// --- NB ADMIN ROUTES ---
app.post('/api/admin/nb/start-sales', auth, adminOnly, async (req, res) => {
  await sb.from('nb_settings').update({ sales_state: 'open', sales_started_at: new Date().toISOString() }).eq('id', 1);
  res.json({ ok: true });
});
app.post('/api/admin/nb/close-sales', auth, adminOnly, async (req, res) => {
  await sb.from('nb_settings').update({ sales_state: 'closed' }).eq('id', 1);
  res.json({ ok: true });
});
app.post('/api/admin/nb/draw', auth, adminOnly, async (req, res) => {
  const s = await getNbSettings();
  const allNums = Array.from({ length: s.total_numbers }, (_, i) => i + 1);
  const winning = allNums.sort(() => Math.random() - 0.5).slice(0, s.drawn_count);
  await sb.from('nb_settings').update({ round_state: 'drawing', drawing_started_at: new Date().toISOString(), winning_numbers: winning }).eq('id', 1);
  res.json({ ok: true });
});
app.post('/api/admin/nb/new-round', auth, adminOnly, async (req, res) => {
  const s = await getNbSettings();
  await sb.from('nb_settings').update({ round_number: Number(s.round_number) + 1, sales_state: 'idle', round_state: 'idle', winning_numbers: [], winners: [] }).eq('id', 1);
  res.json({ ok: true });
});

app.post('/api/nb/settle', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state !== 'drawing') return res.json({ ok: true });
    const elapsed = (Date.now() - new Date(s.drawing_started_at).getTime()) / 1000;
    const totalDrawTime = s.drawn_count * s.draw_delay_seconds;

    if (elapsed >= totalDrawTime) {
      const tickets = await getNbTickets(s.round_number);
      const winnersList = [];
      const userMatches = {};
      const uniqueUsers = new Set(tickets.map(t => t.user_id).filter(Boolean));

      for (const uid of uniqueUsers) {
        const userTickets = tickets.filter(t => t.user_id === uid);
        let matchCount = 0; const matchedNums = [];
        for (const t of userTickets) { if (s.winning_numbers.includes(t.number)) { matchCount++; matchedNums.push(t.number); } }
        if (matchCount > 0) userMatches[uid] = { count: matchCount, nums: matchedNums, user: userTickets[0] };
      }

      const sorted = Object.values(userMatches).sort((a, b) => b.count - a.count);
      const totalSold = tickets.length;
      const totalRevenue = totalSold * s.price_per_purchase;
      const prizePool = totalRevenue * 0.8;

      for (let i = 0; i < Math.min(sorted.length, s.winner_count); i++) {
        const w = sorted[i];
        const percent = (s.prize_percents && s.prize_percents[i]) || 0;
        const prize = (prizePool * percent) / 100;
        winnersList.push({ user_id: w.user.id, name: w.user.user_name, phone_masked: w.user.phone ? w.user.phone.slice(0, 3) + '***' + w.user.phone.slice(-3) : '—', public_code: 'U' + String(w.user.user_id).padStart(5, '0'), matches: w.count, shown_numbers: w.nums, prize: prize, place: i + 1 });
        if (prize > 0) {
          const { data: user } = await sb.from('users').select('balance').eq('id', w.user.user_id).single();
          if (user) await sb.from('users').update({ balance: Number(user.balance) + prize }).eq('id', w.user.user_id);
        }
      }
      await sb.from('nb_settings').update({ round_state: 'finished', winners: winnersList }).eq('id', 1);
      await sb.from('round_history').insert({ game_type: 'nb', round_number: s.round_number, winners: winnersList });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/auto-check', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    if (s.round_state === 'drawing') {
      const elapsed = (Date.now() - new Date(s.drawing_started_at).getTime()) / 1000;
      if (elapsed >= (s.drawn_count * s.draw_delay_seconds)) {
        await fetch(`http://localhost:${process.env.PORT || 3000}/api/nb/settle`, { method: 'POST', headers: { 'Authorization': req.headers.authorization, 'Content-Type': 'application/json' } });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not found in .env' });
    const { message } = req.body;
    const isAdmin = req.user.role === 'admin';
    const systemPrompt = isAdmin ? `You are the Teshe Betting Admin Assistant.` : `You are the Teshe Betting Customer Support AI.`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }], temperature: 0.5 })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'AI failed to respond');
    res.json({ reply: data.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));