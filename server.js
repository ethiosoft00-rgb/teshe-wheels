import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

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

const JWT_SECRET       = process.env.JWT_SECRET || 'change-me';
const ADMIN_RESET_CODE = process.env.ADMIN_RESET_CODE || '100510';
const OWNER_PHONE      = process.env.OWNER_PHONE || '0945757361';

// --- HELPERS ---
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

function generateUniqueId(prefix) {
  return prefix + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function sign(p) { return jwt.sign(p, JWT_SECRET, { expiresIn: '30d' }); }

// --- ROUTES ---

// 1. Config
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// 2. Auth (Register & Login)
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
    res.json({ ok: true, referral_code: myCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    const cleanPhone = String(phone).trim();
    const cleanPassword = String(password).trim();
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

// 3. Main State
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

// 4. NB State & Config (THIS FIXES "NB NOT AVAILABLE")
app.get('/api/nb/config', auth, async (req, res) => {
  try { 
    const s = await getNbSettings(); 
    res.json(s); 
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/state', auth, async (req, res) => {
  try {
    const s = await getNbSettings();
    const tickets = await getNbTickets(s.round_number);
    const my = tickets.filter(t => String(t.user_id) === String(req.user.id));
    const soldCount = tickets.filter(t => t.user_id).length;
    
    res.json({
      settings: s,
      tickets,
      my_tickets: my,
      sold_count: soldCount
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

// 5. Assign Wheel (FAST INSERT)
app.post('/api/admin/tickets/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers, useFreeTicket } = req.body;
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
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
      user.name = cleanName;
    }

    const settings = await getSettings();
    let usedFree = false;
    if (useFreeTicket && (user.free_tickets || 0) > 0) {
      await sb.from('users').update({ free_tickets: user.free_tickets - 1 }).eq('id', user.id);
      usedFree = true;
    }

    const batchId = generateUniqueId('LW');
    const now = new Date().toISOString();
    
    const insertRows = numbers.map(n => ({
      ticket_number: n, user_id: user.id, user_name: cleanName,
      phone: cleanPhone, sold_date: now, round_number: settings.round_number,
      used_free_ticket: usedFree, batch_id: batchId
    }));
    const { error: insertErr } = await sb.from('tickets').insert(insertRows);
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    res.json({ user, numbers, usedFreeTicket: usedFree });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Assign NB (FAST INSERT)
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
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
    }

    const s = await getNbSettings();
    const batchId = generateUniqueId('NB');
    const now = new Date().toISOString();
    
    const insertRows = numbers.map(n => ({
      number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone,
      round_number: s.round_number, sold_date: now, batch_id: batchId, is_free: false
    }));
    const { error: insertErr } = await sb.from('nb_tickets').insert(insertRows);
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. Admin Actions
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

// ... Include other endpoints (deposits, withdrawals, wheel settings) from your original file if needed ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));