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
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const sb = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const OWNER_PHONE = process.env.OWNER_PHONE || '0945757361';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;

/* ============================================================
   AUTH MIDDLEWARE
   ============================================================ */
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'main_admin' && req.user.role !== 'branch') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
function mainAdminOnly(req, res, next) {
  if (req.user.role !== 'main_admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Main Admin only' });
  }
  next();
}

/* ============================================================
   BRANCH SCOPE HELPERS
   ============================================================ */
async function resolveBranchId(req) {
  if (req.user.role === 'branch') return req.user.id;
  if (req.user.role === 'main_admin' || req.user.role === 'admin') return null;
  const { data } = await sb.from('users').select('branch_id').eq('id', req.user.id).maybeSingle();
  return data?.branch_id || null;
}
function adminBranchScope(req) {
  if (req.user.role === 'branch') return req.user.id;
  if (req.user.role === 'main_admin' || req.user.role === 'admin') return null;
  throw new Error('Not admin');
}
function scopeQuery(q, branchId, col = 'branch_id') {
  if (branchId) return q.eq(col, branchId);
  return q.is(col, null);
}
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  if (v == null) return [];
  return [v];
}

const GLOBAL_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

/* ============================================================
   BULLETPROOF SETTINGS HELPERS
   ============================================================ */
async function getSettings(branchId = null) {
  let q = sb.from('app_settings').select('*');
  q = branchId ? q.eq('branch_id', branchId) : q.is('branch_id', null).eq('id', GLOBAL_SETTINGS_ID);
  const { data, error } = await q.maybeSingle();
  
  if (error) throw error;
  
  if (!data && branchId) {
    const newId = crypto.randomUUID();
    const { data: newSettings, error: createErr } = await sb.from('app_settings').insert({
      id: newId,
      branch_id: branchId, round_number: 1, ticket_count: 20, ticket_price: 50,
      sales_state: 'idle', round_state: 'idle', 
      duration_seconds: 30, 
      winner_count: 1,
      prize_percents: [50], sales_duration: 120, referral_goal: 8, referral_reward: 1,
      winner_numbers: [], winners: [], target_rotation: 0
    }).select().single();
    
    if (createErr) {
        console.error("Auto-create settings failed, using fallback.", createErr);
        return {
          branch_id: branchId, round_number: 1, ticket_count: 20, ticket_price: 50,
          sales_state: 'idle', round_state: 'idle', 
          duration_seconds: 30, 
          winner_count: 1,
          prize_percents: [50], sales_duration: 120, referral_goal: 8, referral_reward: 1,
          winner_numbers: [], winners: [], target_rotation: 0, wheel_sold: 0
        };
    }
    return getSettings(branchId);
  }
  
  if (!data) {
      const { data: newSettings, error: createErr } = await sb.from('app_settings').insert({
        id: GLOBAL_SETTINGS_ID,
        branch_id: null, round_number: 1, ticket_count: 20, ticket_price: 50,
        sales_state: 'idle', round_state: 'idle', 
        duration_seconds: 30, 
        winner_count: 1,
        prize_percents: [50], sales_duration: 120, referral_goal: 8, referral_reward: 1,
        winner_numbers: [], winners: [], target_rotation: 0
      }).select().single();
      
      if (createErr) throw createErr;
      return newSettings;
  }

  data.prize_percents = asArray(data.prize_percents);
  data.winner_numbers = asArray(data.winner_numbers);
  data.winners        = asArray(data.winners);

  data.duration_seconds = Number(data.duration_seconds) || 30;
  data.sales_duration = Number(data.sales_duration) || 120;
  data.ticket_count = Number(data.ticket_count) || 20;

  let tq = sb.from('tickets').select('*', { count: 'exact', head: true })
    .eq('round_number', data.round_number).not('user_id', 'is', null);
  tq = scopeQuery(tq, branchId);
  const { count } = await tq;
  data.wheel_sold = count || 0;
  
  return data;
}

// FIX: Ensure tickets exist in the DB for the current round
async function getTickets(branchId = null) {
  const s = await getSettings(branchId);
  let q = sb.from('tickets')
    .select('id,ticket_number,user_id,user_name,phone,sold_date,round_number,batch_id,branch_id')
    .eq('round_number', s.round_number);
  q = scopeQuery(q, branchId);
  const { data, error } = await q.order('ticket_number');
  if (error) throw error;
  
  // If the tickets table is empty for this round, generate them!
  if (!data || data.length === 0) {
      const count = Number(s.ticket_count) || 20;
      const newTickets = [];
      for (let i = 1; i <= count; i++) {
          newTickets.push({
              ticket_number: i,
              round_number: s.round_number,
              branch_id: branchId
          });
      }
      await sb.from('tickets').insert(newTickets);
      
      // Fetch again
      let q2 = sb.from('tickets')
        .select('id,ticket_number,user_id,user_name,phone,sold_date,round_number,batch_id,branch_id')
        .eq('round_number', s.round_number);
      q2 = scopeQuery(q2, branchId);
      const { data: newData } = await q2.order('ticket_number');
      return newData || [];
  }
  
  return data;
}

async function getNbSettings(branchId = null) {
  let q = sb.from('nb_settings').select('*');
  q = branchId ? q.eq('branch_id', branchId) : q.is('branch_id', null).eq('id', GLOBAL_SETTINGS_ID);
  const { data, error } = await q.maybeSingle();
  
  if (error) throw error;

  if (!data && branchId) {
    const newId = crypto.randomUUID();
    const insertData = {
      id: newId,
      branch_id: branchId, round_number: 1, total_numbers: 80, drawn_count: 20,
      tickets_per_purchase: 2, price_per_purchase: 30, draw_delay_seconds: 2,
      round_duration_minutes: 120, winner_count: 3, prize_percents: [50, 30, 20],
      sales_state: 'idle', round_state: 'idle', winning_numbers: [], winners: []
    };
    const { data: newSettings, error: createErr } = await sb.from('nb_settings').insert(insertData).select().single();
    
    if (createErr) {
        console.error("Auto-create NB settings failed, using fallback.", createErr);
        return {
            branch_id: branchId, round_number: 1, total_numbers: 80, drawn_count: 20,
            tickets_per_purchase: 2, price_per_purchase: 30, draw_delay_seconds: 2,
            round_duration_minutes: 120, winner_count: 3, prize_percents: [50, 30, 20],
            sales_state: 'idle', round_state: 'idle', winning_numbers: [], winners: []
        };
    }
    return getNbSettings(branchId); 
  }

  if (!data) {
      const { data: newSettings, error: createErr } = await sb.from('nb_settings').insert({
        id: GLOBAL_SETTINGS_ID,
        branch_id: null, round_number: 1, total_numbers: 80, drawn_count: 20,
        tickets_per_purchase: 2, price_per_purchase: 30, draw_delay_seconds: 2,
        round_duration_minutes: 120, winner_count: 3, prize_percents: [50, 30, 20],
        sales_state: 'idle', round_state: 'idle', winning_numbers: [], winners: []
      }).select().single();
      if (createErr) throw createErr;
      return newSettings;
  }

  data.prize_percents  = asArray(data.prize_percents);
  data.winning_numbers = asArray(data.winning_numbers);
  data.winners         = asArray(data.winners);
  
  data.winning_numbers = data.winning_numbers || [];
  data.winners = data.winners || [];
  data.total_numbers = Number(data.total_numbers) || 80;
  data.drawn_count = Number(data.drawn_count) || 20;
  data.draw_delay_seconds = Number(data.draw_delay_seconds) || 2;
  data.tickets_per_purchase = Number(data.tickets_per_purchase) || 1;
  data.price_per_purchase = Number(data.price_per_purchase) || 0;

  return data;
}

async function getNbTickets(branchId, roundNumber) {
  let q = sb.from('nb_tickets').select('*').eq('round_number', roundNumber);
  q = scopeQuery(q, branchId);
  const { data, error } = await q.order('number');
  if (error) throw error;
  return data || [];
}

async function updateSettings(branchId, patch, table = 'app_settings') {
  try {
    if (branchId) {
      const { data: existing, error: checkErr } = await sb.from(table)
        .select('id')
        .eq('branch_id', branchId)
        .maybeSingle();

      if (checkErr) throw checkErr;

      if (existing) {
        const { error: updateErr } = await sb.from(table)
          .update(patch)
          .eq('branch_id', branchId);
        if (updateErr) throw updateErr;
      } else {
        const newId = crypto.randomUUID();
        const { error: insertErr } = await sb.from(table)
          .insert({ id: newId, branch_id: branchId, ...patch });
        if (insertErr) throw insertErr;
      }
    } else {
      const { error } = await sb.from(table)
        .update(patch)
        .eq('id', GLOBAL_SETTINGS_ID)
        .is('branch_id', null);
      if (error) throw error;
    }
  } catch (error) {
    console.error(`🔥 UPDATE SETTINGS ERROR (${table}):`, error);
    throw error;
  }
}

/* ============================================================
   MISC HELPERS
   ============================================================ */
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
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase(); 
  return prefix + '-' + randomPart; 
}

function sign(p) { return jwt.sign(p, JWT_SECRET, { expiresIn: '30d' }); }

/* ============================================================
   PUBLIC CONFIG
   ============================================================ */
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY });
});

app.get('/api/nb/config', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const s = await getNbSettings(branchId);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   REGISTER & LOGIN
   ============================================================ */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password, referralCode, branchCode } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Please fill all fields' });
    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    const cleanPassword = String(password).trim();
    if (cleanPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
    if (cleanPhone === OWNER_PHONE) return res.status(400).json({ error: 'This phone number is reserved' });
    
    const { data: exists } = await sb.from('users').select('id').eq('phone', cleanPhone).maybeSingle();
    if (exists) return res.status(400).json({ error: 'Phone already registered' });

    let referredBy = null;
    let branchId = null;

    if (referralCode && String(referralCode).trim()) {
      const cleanRef = String(referralCode).trim().toUpperCase();
      const { data: refUser } = await sb.from('users').select('id').eq('referral_code', cleanRef).maybeSingle();
      if (refUser) referredBy = refUser.id;
    }
    if (branchCode && String(branchCode).trim()) {
      const cleanBranch = String(branchCode).trim().toUpperCase();
      const { data: refBranch } = await sb.from('branches').select('id').eq('code', cleanBranch).maybeSingle();
      if (refBranch) branchId = refBranch.id;
    }

    const hash = await bcrypt.hash(cleanPassword, 10);
    const myCode = await generateReferralCode();
    const { error } = await sb.from('users').insert({
      name: cleanName, phone: cleanPhone, password_hash: hash, password_plain: cleanPassword,
      role: 'user', balance: 0, referral_code: myCode, referred_by: referredBy,
      branch_id: branchId, banned: false
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

    const { data: branch } = await sb.from('branches').select('*').eq('admin_phone', cleanPhone).maybeSingle();
    if (branch) {
      const ok = await bcrypt.compare(cleanPassword, branch.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid phone number or password' });
      const token = sign({ id: branch.id, role: 'branch', phone: branch.admin_phone });
      return res.json({ token, role: 'branch', name: branch.name });
    }

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

/* ============================================================
   STATE & USER ROUTES
   ============================================================ */
app.get('/api/state', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const settings = await getSettings(branchId);
    const tickets  = await getTickets(branchId);
    let me;

    if (req.user.role === 'main_admin' || req.user.role === 'admin') {
      const { data } = await sb.from('users')
        .select('id,name,phone,role,balance,free_tickets,referral_code,active_referrals,public_id')
        .eq('id', req.user.id).maybeSingle();
      me = data || { id: req.user.id, name: 'Admin', phone: req.user.phone, role: 'admin', balance: 0, free_tickets: 0 };
    } else if (req.user.role === 'branch') {
      const { data } = await sb.from('branches')
        .select('id,name,admin_phone,code,telegram_link,holder_name,receipt_company_name')
        .eq('id', req.user.id).maybeSingle();
      me = { ...(data || {}), role: 'branch', branch_name: data?.name };
    } else {
      const { data } = await sb.from('users')
        .select('id,name,phone,balance,role,referral_code,active_referrals,free_tickets,has_bought_ticket,public_id,branch_id')
        .eq('id', req.user.id).maybeSingle();
      me = data;
      if (me && me.branch_id) {
        const { data: b } = await sb.from('branches').select('telegram_link,name').eq('id', me.branch_id).maybeSingle();
        if (b) { me.telegram_link = b.telegram_link; me.branch_name = b.name; }
      }
    }
    res.json({ settings, tickets, me });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wheel/my-tickets', auth, async (req, res) => {
  try {
    let q = sb.from('tickets').select('*').eq('user_id', req.user.id).order('round_number', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    res.json({ tickets: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nb/my-tickets', auth, async (req, res) => {
  try {
    let q = sb.from('nb_tickets').select('*').eq('user_id', req.user.id).order('round_number', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    res.json({ tickets: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/tickets/buy', auth, async (req, res) => {
  try {
    const { numbers, useFreeTicket } = req.body;
    const branchId = await resolveBranchId(req);
    const s = await getSettings(branchId);
    
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'Sales are closed' });

    const { data: me } = await sb.from('users').select('balance, free_tickets').eq('id', req.user.id).maybeSingle();
    
    let cost = numbers.length * Number(s.ticket_price);
    let usedFree = false;

    if (useFreeTicket) {
      if (me.free_tickets < 1) return res.status(400).json({ error: 'No free tickets available' });
      if (numbers.length > 1) return res.status(400).json({ error: 'Free ticket allows only 1 selection' });
      cost = 0;
      usedFree = true;
      await sb.from('users').update({ free_tickets: me.free_tickets - 1 }).eq('id', req.user.id);
    } else {
      if (Number(me.balance) < cost) return res.status(400).json({ error: 'Insufficient balance' });
      await sb.from('users').update({ balance: Number(me.balance) - cost }).eq('id', req.user.id);
    }

    const batchId = generateUniqueId('LW');
    const now = new Date().toISOString();
    const { data: user } = await sb.from('users').select('name, phone').eq('id', req.user.id).single();

    for (const n of numbers) {
      let updQ = sb.from('tickets')
        .update({
          user_id: req.user.id, user_name: user.name, phone: user.phone,
          sold_date: now, batch_id: batchId, used_free_ticket: usedFree
        })
        .eq('round_number', s.round_number)
        .eq('ticket_number', n)
        .is('user_id', null); 

      updQ = scopeQuery(updQ, branchId);
      const { data: updated } = await updQ.select('id');

      if (!updated || updated.length === 0) {
        await sb.from('tickets').insert({
          ticket_number: n, user_id: req.user.id, user_name: user.name, phone: user.phone,
          sold_date: now, round_number: s.round_number, used_free_ticket: usedFree,
          batch_id: batchId, branch_id: branchId
        });
      }
    }
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/buy', auth, async (req, res) => {
  try {
    const { numbers } = req.body;
    const branchId = await resolveBranchId(req);
    const s = await getNbSettings(branchId);
    
    if (s.sales_state !== 'open') return res.status(400).json({ error: 'Sales are closed' });
    if (numbers.length !== Number(s.tickets_per_purchase)) return res.status(400).json({ error: 'Invalid number selection' });

    const { data: me } = await sb.from('users').select('balance').eq('id', req.user.id).maybeSingle();
    const cost = Number(s.price_per_purchase);
    if (Number(me.balance) < cost) return res.status(400).json({ error: 'Insufficient balance' });

    await sb.from('users').update({ balance: Number(me.balance) - cost }).eq('id', req.user.id);

    const batchId = generateUniqueId('NB');
    const now = new Date().toISOString();
    const { data: user } = await sb.from('users').select('name, phone').eq('id', req.user.id).single();

    const insertRows = numbers.map(n => ({
      number: n, user_id: req.user.id, user_name: user.name, phone: user.phone,
      round_number: s.round_number, sold_date: now, batch_id: batchId,
      is_free: false, branch_id: branchId
    }));
    const { error } = await sb.from('nb_tickets').insert(insertRows);
    if (error) throw error;
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/referrals', auth, async (req, res) => {
  try {
    if (['admin', 'main_admin', 'branch'].includes(req.user.role)) return res.json({ referrals: [] });
    const { data, error } = await sb.from('users')
      .select('name, phone, has_bought_ticket')
      .eq('referred_by', req.user.id);
    if (error) throw error;
    res.json({ referrals: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   BRANCH ROUTES
   ============================================================ */
app.get('/api/admin/branches', auth, mainAdminOnly, async (req, res) => {
  try {
    const { data, error } = await sb.from('branches').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ branches: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/branches', auth, mainAdminOnly, async (req, res) => {
  try {
    const { name, code, admin_phone, password, cbe_account, boa_account, holder_name, telegram_link, receipt_company_name } = req.body;
    if (!name || !code || !admin_phone || !password) return res.status(400).json({ error: 'Missing required fields' });

    const cleanCode = String(code).trim().toUpperCase();
    const cleanPhone = String(admin_phone).trim();
    const hash = await bcrypt.hash(String(password).trim(), 10);

    const { data, error } = await sb.from('branches').insert({
      name: String(name).trim(), code: cleanCode, admin_phone: cleanPhone, password_hash: hash,
      cbe_account, boa_account,
      holder_name: holder_name ? String(holder_name).trim() : null,
      telegram_link: telegram_link ? String(telegram_link).trim() : null,
      receipt_company_name: receipt_company_name ? String(receipt_company_name).trim() : null
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    await sb.from('app_settings').insert({
      id: crypto.randomUUID(),
      branch_id: data.id, round_number: 1, ticket_count: 20, ticket_price: 50,
      sales_state: 'idle', round_state: 'idle', duration_seconds: 30, winner_count: 1,
      prize_percents: [50], sales_duration: 120, referral_goal: 8, referral_reward: 1,
      winner_numbers: [], winners: [], target_rotation: 0
    });

    await sb.from('nb_settings').insert({
      id: crypto.randomUUID(),
      branch_id: data.id, round_number: 1, total_numbers: 80, drawn_count: 20,
      tickets_per_purchase: 2, price_per_purchase: 30, draw_delay_seconds: 2,
      round_duration_minutes: 120, winner_count: 3, prize_percents: [50, 30, 20],
      sales_state: 'idle', round_state: 'idle', winning_numbers: [], winners: []
    });

    res.json({ ok: true, branch: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/branches/:id', auth, async (req, res) => {
  try {
    const branchId = req.params.id;
    if (req.user.role !== 'main_admin' && req.user.role !== 'admin') {
      if (req.user.role === 'branch' && req.user.id !== branchId) return res.status(403).json({ error: 'Not authorized' });
      if (req.user.role === 'user') {
        const { data: u } = await sb.from('users').select('branch_id').eq('id', req.user.id).maybeSingle();
        if (!u || u.branch_id !== branchId) return res.status(403).json({ error: 'Not authorized' });
      }
    }

    const { name, admin_phone, password, cbe_account, boa_account, holder_name, telegram_link, receipt_company_name } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (admin_phone !== undefined) update.admin_phone = admin_phone;
    if (cbe_account !== undefined) update.cbe_account = cbe_account;
    if (boa_account !== undefined) update.boa_account = boa_account;
    if (holder_name !== undefined) update.holder_name = holder_name ? String(holder_name).trim() : null;
    if (telegram_link !== undefined) update.telegram_link = telegram_link ? String(telegram_link).trim() : null;
    if (receipt_company_name !== undefined) update.receipt_company_name = receipt_company_name ? String(receipt_company_name).trim() : null;
    if (password) update.password_hash = await bcrypt.hash(String(password).trim(), 10);

    const { error } = await sb.from('branches').update(update).eq('id', branchId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/branches/:id', auth, mainAdminOnly, async (req, res) => {
  try {
    await sb.from('users').update({ branch_id: null }).eq('branch_id', req.params.id);
    await sb.from('app_settings').delete().eq('branch_id', req.params.id);
    await sb.from('nb_settings').delete().eq('branch_id', req.params.id);
    const { error } = await sb.from('branches').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/branch-details', auth, async (req, res) => {
  try {
    if (!req.user.id) return res.json({});
    const { data: user } = await sb.from('users').select('branch_id').eq('id', req.user.id).maybeSingle();
    if (!user || !user.branch_id) return res.json({});
    const { data: branch } = await sb.from('branches')
      .select('cbe_account, boa_account, holder_name, telegram_link, name, code')
      .eq('id', user.branch_id).maybeSingle();
    res.json(branch || {});
  } catch (e) { res.json({}); }
});

/* ============================================================
   ADMIN FINANCE, MESSAGES & AUDIT
   ============================================================ */
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    
    let depQuery = sb.from('deposits').select('amount, created_at').eq('status', 'approved');
    let wdQuery = sb.from('withdrawals').select('amount, created_at').eq('status', 'approved');
    let ticketQuery = sb.from('tickets').select('ticket_price, sold_date, user_id').not('user_id', 'is', null);
    let nbQuery = sb.from('nb_tickets').select('price_per_purchase, sold_date, user_id').not('user_id', 'is', null);

    if (branchId) {
      depQuery = depQuery.eq('branch_id', branchId);
      wdQuery = wdQuery.eq('branch_id', branchId);
      ticketQuery = ticketQuery.eq('branch_id', branchId);
      nbQuery = nbQuery.eq('branch_id', branchId);
    }

    const [{ data: deps }, { data: wds }, { data: tickets }, { data: nbTickets }] = await Promise.all([depQuery, wdQuery, ticketQuery, nbQuery]);

    const totalDeposit = (deps || []).reduce((sum, d) => sum + Number(d.amount), 0);
    const totalWithdraw = (wds || []).reduce((sum, w) => sum + Number(w.amount), 0);
    const totalSales = (tickets || []).reduce((sum, t) => sum + Number(t.ticket_price), 0) + 
                       (nbTickets || []).reduce((sum, t) => sum + Number(t.price_per_purchase), 0);
    const totalProfit = totalSales - totalWithdraw;

    const today = new Date().toISOString().split('T')[0];
    
    let historyQuery = sb.from('round_history').select('winners, created_at');
    if (branchId) historyQuery = historyQuery.eq('branch_id', branchId);
    const { data: history } = await historyQuery;
    
    let todayWinnerPayouts = 0;
    (history || []).forEach(h => {
      if (h.created_at.startsWith(today) && h.winners) {
        todayWinnerPayouts += h.winners.reduce((sum, w) => sum + Number(w.prize || 0), 0);
      }
    });

    const todaySales = (tickets || []).filter(t => t.sold_date.startsWith(today)).reduce((sum, t) => sum + Number(t.ticket_price), 0) +
                       (nbTickets || []).filter(t => t.sold_date.startsWith(today)).reduce((sum, t) => sum + Number(t.price_per_purchase), 0);
    const todayWithdraw = (wds || []).filter(w => w.created_at.startsWith(today)).reduce((sum, w) => sum + Number(w.amount), 0);
    const todayProfit = todaySales - todayWithdraw - todayWinnerPayouts;

    res.json({ totalDeposit, totalWithdraw, totalProfit, todayProfit, todayWinnerPayouts });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/messages', auth, adminOnly, async (req, res) => {
  try {
    const { receiver_id, message, amount_requested, account_number, holder_name, screenshot, transaction_id, request_id, status } = req.body;
    const sender_role = req.user.role === 'branch' ? 'branch' : 'main_admin';
    
    const payload = {
      sender_role,
      sender_id: req.user.id,
      receiver_role: sender_role === 'main_admin' ? 'branch' : 'main_admin',
      receiver_id: sender_role === 'main_admin' ? receiver_id : null,
      message,
      amount_requested: amount_requested || 0,
      account_number: account_number || null,
      holder_name: holder_name || null,
      screenshot: screenshot || null,
      transaction_id: transaction_id || null,
      request_id: request_id || null
    };
    if (status) payload.status = status;

    const { error } = await sb.from('admin_messages').insert(payload);
    
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/messages', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    let query = sb.from('admin_messages').select('*').order('created_at', { ascending: false });

    if (branchId) {
      query = query.or(`receiver_id.eq.${branchId},sender_id.eq.${branchId}`);
    } else {
      query = query.or(`receiver_role.eq.main_admin,sender_role.eq.main_admin`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/messages/decide', auth, mainAdminOnly, async (req, res) => {
  try {
    const { id, status } = req.body;
    
    const { error } = await sb.from('admin_messages').update({ status }).eq('id', id);
    if (error) {
      console.error("Decide Error:", error);
      return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/daily-records', auth, mainAdminOnly, async (req, res) => {
  try {
    const branches = (await sb.from('branches').select('id, name')).data || [];
    
    const [deposits, tickets, nbTickets, history] = await Promise.all([
      sb.from('deposits').select('branch_id, amount').eq('status', 'approved'),
      sb.from('tickets').select('branch_id, ticket_price').not('user_id', 'is', null),
      sb.from('nb_tickets').select('branch_id, price_per_purchase').not('user_id', 'is', null),
      sb.from('round_history').select('branch_id, winners, created_at')
    ]);

    const records = [];
    for (const branch of branches) {
      const bDeposits = (deposits.data || []).filter(d => d.branch_id === branch.id).reduce((s, d) => s + Number(d.amount), 0);
      const bTickets = (tickets.data || []).filter(t => t.branch_id === branch.id).reduce((s, t) => s + Number(t.ticket_price), 0);
      const bNbTickets = (nbTickets.data || []).filter(t => t.branch_id === branch.id).reduce((s, t) => s + Number(t.price_per_purchase), 0);
      const bSales = bTickets + bNbTickets;
      
      let bPayouts = 0;
      (history.data || []).filter(h => h.branch_id === branch.id).forEach(h => {
        bPayouts += (h.winners || []).reduce((sum, w) => sum + Number(w.prize || 0), 0);
      });

      records.push({
        branch_id: branch.id,
        branch_name: branch.name,
        daily_collected: bSales,
        daily_payouts: bPayouts,
        daily_net_profit: bSales - bPayouts,
        daily_deposits: bDeposits
      });
    }

    res.json({ records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/audit', auth, mainAdminOnly, async (req, res) => {
  try {
    const { data: branches } = await sb.from('branches').select('id, name');
    
    const { data: deposits } = await sb.from('deposits').select('*, users!inner(branch_id)').eq('status', 'approved');
    const { data: tickets } = await sb.from('tickets').select('branch_id, ticket_price, sold_date').not('user_id', 'is', null);
    const { data: nbTickets } = await sb.from('nb_tickets').select('branch_id, price_per_purchase, sold_date').not('user_id', 'is', null);
    const { data: history } = await sb.from('round_history').select('branch_id, winners, created_at');
    
    const auditLog = {};

    (deposits || []).forEach(d => {
        let dateStr = 'Unknown';
        if (d.created_at) {
            try { dateStr = new Date(d.created_at).toISOString().split('T')[0]; } catch(e) {}
        }
        
        const branchId = d.users?.branch_id;
        if (!branchId) return;

        if (!auditLog[dateStr]) auditLog[dateStr] = {};
        if (!auditLog[dateStr][branchId]) auditLog[dateStr][branchId] = { deposit_amt: 0, sales_amt: 0, payout_amt: 0 };
        
        auditLog[dateStr][branchId].deposit_amt += Number(d.amount || 0);
    });

    (tickets || []).forEach(t => {
        const dateStr = t.sold_date ? t.sold_date.split('T')[0] : 'Unknown';
        if (!t.branch_id || dateStr === 'Unknown') return;
        if (!auditLog[dateStr]) auditLog[dateStr] = {};
        if (!auditLog[dateStr][t.branch_id]) auditLog[dateStr][t.branch_id] = { deposit_amt: 0, sales_amt: 0, payout_amt: 0 };
        auditLog[dateStr][t.branch_id].sales_amt += Number(t.ticket_price || 0);
    });
    (nbTickets || []).forEach(t => {
        const dateStr = t.sold_date ? t.sold_date.split('T')[0] : 'Unknown';
        if (!t.branch_id || dateStr === 'Unknown') return;
        if (!auditLog[dateStr]) auditLog[dateStr] = {};
        if (!auditLog[dateStr][t.branch_id]) auditLog[dateStr][t.branch_id] = { deposit_amt: 0, sales_amt: 0, payout_amt: 0 };
        auditLog[dateStr][t.branch_id].sales_amt += Number(t.price_per_purchase || 0);
    });

    (history || []).forEach(h => {
        const dateStr = h.created_at ? h.created_at.split('T')[0] : 'Unknown';
        if (!h.branch_id || dateStr === 'Unknown') return;
        if (!auditLog[dateStr]) auditLog[dateStr] = {};
        if (!auditLog[dateStr][h.branch_id]) auditLog[dateStr][h.branch_id] = { deposit_amt: 0, sales_amt: 0, payout_amt: 0 };
        const wSum = (h.winners || []).reduce((sum, w) => sum + Number(w.prize || 0), 0);
        auditLog[dateStr][h.branch_id].payout_amt += wSum;
    });

    res.json({ branches: branches || [], auditLog });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   TICKET RECEIPT
   ============================================================ */
app.post('/api/ticket-receipt', auth, async (req, res) => {
  try {
    const { game, round, tickets } = req.body;
    const branchId = await resolveBranchId(req);
    const settings = game === 'nb' ? await getNbSettings(branchId) : await getSettings(branchId);

    let owner = { name: 'Admin', phone: '-' };
    let receipt_company = 'Lucky Wheel';

    if (req.user.role !== 'admin' && req.user.role !== 'main_admin') {
      if (req.user.role === 'branch') {
        const { data: b } = await sb.from('branches').select('name, receipt_company_name').eq('id', req.user.id).maybeSingle();
        if (b) receipt_company = b.receipt_company_name || b.name;
        owner = { name: b?.name || 'Branch', phone: '-' };
      } else {
        const { data: u } = await sb.from('users').select('name,phone,public_id,branch_id').eq('id', req.user.id).maybeSingle();
        if (u) {
          owner = { name: u.name, phone: u.phone, public_code: u.public_id ? 'U' + String(u.public_id).padStart(5, '0') : null };
          if (u.branch_id) {
            const { data: b } = await sb.from('branches').select('receipt_company_name, name, code, telegram_link').eq('id', u.branch_id).maybeSingle();
            if (b) {
              receipt_company = b.receipt_company_name || b.name;
              owner.branch_name = b.name;
              owner.branch_code = b.code;
              owner.branch_telegram = b.telegram_link;
            }
          }
        }
      }
    }

    let batchId = 'TICKET-' + tickets[0];
    if (game === 'nb') {
      let q = sb.from('nb_tickets').select('batch_id, number').eq('round_number', round).in('number', tickets);
      q = scopeQuery(q, branchId);
      const { data } = await q;
      if (data && data.length && data[0].batch_id) batchId = data[0].batch_id;
    } else {
      let q = sb.from('tickets').select('batch_id, ticket_number').eq('round_number', round).in('ticket_number', tickets);
      q = scopeQuery(q, branchId);
      const { data } = await q;
      if (data && data.length && data[0].batch_id) batchId = data[0].batch_id;
    }
    const enriched = tickets.map(t => ({ number: typeof t === 'object' ? t.number : t, printer_code: batchId }));

    res.json({
      ok: true, game: game === 'nb' ? 'Number Betting' : 'Lucky Wheel',
      round, tickets: enriched, owner, ref: batchId, date: new Date().toISOString(),
      price: game === 'nb' ? Number(settings.price_per_purchase) : Number(settings.ticket_price),
      receipt_company, branch_name: owner.branch_name, branch_code: owner.branch_code, branch_telegram: owner.branch_telegram
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   VERIFY TICKET & ASSIGN LOGIC (EXTREMELY AGGRESSIVE FIX)
   ============================================================ */
app.post('/api/verify-ticket', auth, async (req, res) => {
  try {
    let { printerCode, ticketNumber, unique_id } = req.body;
    const originalInput = String(ticketNumber || unique_id || printerCode || '').trim();
    if (!originalInput) return res.status(400).json({ error: 'Ticket ID required' });

    let cleanInput = originalInput.toUpperCase();
    let numericStr = cleanInput;
    for (const p of ['TICKET-', 'NB-', 'LW-']) {
      if (numericStr.startsWith(p)) numericStr = numericStr.slice(p.length);
    }

    let ticket = null;
    let isNb = false;
    
    let q1 = sb.from('tickets').select('*').ilike('batch_id', cleanInput).limit(1);
    let q2 = sb.from('nb_tickets').select('*').ilike('batch_id', cleanInput).limit(1);
    
    const { data: t1Batch } = await q1;
    const { data: t2Batch } = await q2;

    if (t1Batch && t1Batch.length > 0) { ticket = t1Batch[0]; isNb = false; }
    else if (t2Batch && t2Batch.length > 0) { ticket = t2Batch[0]; isNb = true; }
    
    if (!ticket) {
        let q1Like = sb.from('tickets').select('*').ilike('batch_id', `%${cleanInput}%`).limit(1);
        let q2Like = sb.from('nb_tickets').select('*').ilike('batch_id', `%${cleanInput}%`).limit(1);
        const { data: t1Like } = await q1Like;
        const { data: t2Like } = await q2Like;
        if (t1Like && t1Like.length > 0) { ticket = t1Like[0]; isNb = false; }
        else if (t2Like && t2Like.length > 0) { ticket = t2Like[0]; isNb = true; }
    }

    if (!ticket && !isNaN(Number(numericStr))) {
        let q3 = sb.from('tickets').select('*').eq('ticket_number', Number(numericStr)).order('round_number', { ascending: false }).limit(1);
        let q4 = sb.from('nb_tickets').select('*').eq('number', Number(numericStr)).order('round_number', { ascending: false }).limit(1);
        const { data: t3Num } = await q3;
        const { data: t4Num } = await q4;
        if (t3Num && t3Num.length > 0) { ticket = t3Num[0]; isNb = false; }
        else if (t4Num && t4Num.length > 0) { ticket = t4Num[0]; isNb = true; }
    }
    
    let history = null;
    if (!ticket) {
        let allHistory = await sb.from('round_history').select('*').order('created_at', { ascending: false }).limit(500);
        if (allHistory.data) {
             history = allHistory.data.find(h => {
                 if (h.tickets && Array.isArray(h.tickets)) {
                     const matchTicket = h.tickets.find(t => 
                         String(t.batch_id).toUpperCase() === cleanInput || 
                         String(t.batch_id).toUpperCase().includes(cleanInput) ||
                         String(t.number) === numericStr
                     );
                     if (matchTicket) {
                         ticket = {
                             ticket_number: matchTicket.number,
                             number: matchTicket.number,
                             round_number: h.round_number,
                             user_name: matchTicket.user_name || matchTicket.owner_name || 'Unknown',
                             phone: matchTicket.phone || '—',
                             branch_id: h.branch_id,
                             batch_id: matchTicket.batch_id || cleanInput,
                             sold_date: h.created_at
                         };
                         isNb = h.game_type === 'nb';
                         return true;
                     }
                 }
                 if (h.winners) {
                     return h.winners.some(w => 
                         (w.ticket && String(w.ticket) === cleanInput) || 
                         (w.shown_numbers && w.shown_numbers.map(String).includes(cleanInput))
                     );
                 }
                 return false;
             });
             
             if (history && !ticket) {
                 const w = history.winners.find(w => 
                     (w.ticket && String(w.ticket) === cleanInput) || 
                     (w.shown_numbers && w.shown_numbers.map(String).includes(cleanInput))
                 );
                 ticket = {
                     ticket_number: w.ticket || w.shown_numbers?.[0],
                     number: w.ticket || w.shown_numbers?.[0],
                     round_number: history.round_number,
                     user_name: w.name,
                     phone: w.phone_masked,
                     branch_id: history.branch_id,
                     batch_id: w.uid || cleanInput,
                     sold_date: history.created_at
                 };
                 isNb = history.game_type === 'nb';
             }
        }
    }

    if (!ticket) return res.status(404).json({ error: 'Ticket not found in any round.' });

    const ticketBranchId = ticket.branch_id || null;

    if (!history) {
        const { data: histData } = await sb.from('round_history')
            .select('*')
            .eq('round_number', ticket.round_number)
            .eq('game_type', isNb ? 'nb' : 'wheel')
            .order('created_at', { ascending: false })
            .limit(1);
        if (histData && histData.length) history = histData[0];
    }

    let status = 'pending';
    let prize = 0;
    let match_count = 0;
    let winning_numbers = [];

    const ticketNum = isNb ? Number(ticket.number) : Number(ticket.ticket_number);

    if (history) {
      winning_numbers = asArray(history.winning_numbers || history.winner_numbers || []);
      
      if (history.winners) {
        const winnersArr = asArray(history.winners);
        const winnerObj = winnersArr.find(w =>
          (w.ticket != null && Number(w.ticket) === ticketNum) ||
          (w.shown_numbers && w.shown_numbers.map(Number).includes(ticketNum))
        );

        if (winnerObj) {
          status = 'winner';
          prize = Number(winnerObj.prize || 0);
          match_count = Number(winnerObj.matches || (winnerObj.shown_numbers?.length || 1));
        } else {
          status = 'not_winner';
          if (isNb && winning_numbers.length) {
            const winSet = new Set(winning_numbers.map(Number));
            match_count = winSet.has(ticketNum) ? 1 : 0;
          }
        }
      } else {
        status = 'not_winner';
      }
    } else {
      const currentSettings = await getSettings(ticketBranchId);
      const isCurrentRound = (ticket.round_number === currentSettings.round_number);
      if (isCurrentRound) status = 'progress';
      else status = 'past_round'; 
    }

    res.json({
      ok: true,
      game: isNb ? 'Number Betting' : 'Lucky Wheel',
      numbers: [ticketNum],
      unique_id: ticket.batch_id || originalInput,
      round: ticket.round_number,
      owner_name: ticket.user_name,
      owner_phone: ticket.phone,
      sold_date: ticket.sold_date || history?.created_at || new Date().toISOString(),
      round_is_past: true,
      round_finished: ['winner','not_winner','past_round'].includes(status),
      is_winner: status === 'winner',
      prize,
      match_count,
      winning_numbers,
      status,
      branch_id: ticketBranchId
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tickets/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers, useFreeTicket } = req.body;
    const cleanName = String(name).trim(); const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();

    const branchId = req.user.role === 'branch' ? req.user.id : null;

    if (!user) {
      const hash = await bcrypt.hash(String(password || '1234').trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({
        name: cleanName, phone: cleanPhone, password_hash: hash,
        password_plain: String(password || '1234').trim(), role: 'user',
        balance: Math.max(0, Number(balance) || 0), referral_code: newCode,
        banned: false, branch_id: branchId
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
    }

    const settings = await getSettings(branchId);

    let usedFree = false;
    if (useFreeTicket && (user.free_tickets || 0) > 0) {
      await sb.from('users').update({ free_tickets: user.free_tickets - 1 }).eq('id', user.id);
      usedFree = true;
    }

    const batchId = generateUniqueId('LW');
    const now = new Date().toISOString();

    for (const n of numbers) {
      let updQ = sb.from('tickets')
        .update({
          user_id: user.id, user_name: cleanName, phone: cleanPhone,
          sold_date: now, batch_id: batchId, used_free_ticket: usedFree
        })
        .eq('round_number', settings.round_number)
        .eq('ticket_number', n)
        .is('user_id', null); 

      updQ = scopeQuery(updQ, branchId);
      const { data: updated } = await updQ.select('id');

      if (!updated || updated.length === 0) {
        await sb.from('tickets').insert({
          ticket_number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone,
          sold_date: now, round_number: settings.round_number, used_free_ticket: usedFree,
          batch_id: batchId, branch_id: branchId
        });
      }
    }

    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/assign', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, password, balance, numbers } = req.body;
    const cleanName = String(name).trim(); const cleanPhone = String(phone).trim();
    let { data: user } = await sb.from('users').select('*').eq('phone', cleanPhone).maybeSingle();

    const branchId = req.user.role === 'branch' ? req.user.id : null;

    if (!user) {
      const hash = await bcrypt.hash(String(password || '1234').trim(), 10);
      const newCode = await generateReferralCode();
      const { data: created, error } = await sb.from('users').insert({
        name: cleanName, phone: cleanPhone, password_hash: hash,
        password_plain: String(password || '1234').trim(), role: 'user',
        balance: Math.max(0, Number(balance) || 0), referral_code: newCode,
        banned: false, branch_id: branchId
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      user = created;
    } else {
      const nb = Number(user.balance) + (Number(balance) || 0);
      await sb.from('users').update({ name: cleanName, balance: nb }).eq('id', user.id);
    }

    const s = await getNbSettings(branchId);
    const batchId = generateUniqueId('NB');
    const now = new Date().toISOString();
    const insertRows = numbers.map(n => ({
      number: n, user_id: user.id, user_name: cleanName, phone: cleanPhone,
      round_number: s.round_number, sold_date: now, batch_id: batchId,
      is_free: false, branch_id: branchId
    }));
    const { error } = await sb.from('nb_tickets').insert(insertRows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   ADMIN USERS / REQUESTS
   ============================================================ */
app.get('/api/admin/users/full', auth, adminOnly, async (req, res) => {
  try {
    let query = sb.from('users').select('*').eq('role', 'user');
    if (req.user.role === 'branch') query = query.eq('branch_id', req.user.id);
    const { data: users, error } = await query.order('created_at');
    if (error) throw error;
    res.json({ users: users || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/withdrawals', auth, async (req, res) => {
  try { const { data, error } = await sb.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }); if (error) throw error; res.json({ withdrawals: data || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/withdrawals', auth, async (req, res) => {
  try {
    const { method, amount, accountNumber } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!accountNumber) return res.status(400).json({ error: 'Account number required' });
    const { data: me } = await sb.from('users').select('balance').eq('id', req.user.id).maybeSingle();
    if (!me || Number(me.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const { error } = await sb.from('withdrawals').insert({
      user_id: req.user.id, user_name: req.user.phone, phone: req.user.phone,
      method, amount, account_number: accountNumber, status: 'pending'
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/deposits', auth, async (req, res) => {
  try {
    const { method, amount, transactionId, screenshot } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!transactionId && !screenshot) return res.status(400).json({ error: 'Provide a Transaction ID or Screenshot' });
    let finalTxnId = transactionId;
    if (!finalTxnId || finalTxnId === 'SCREENSHOT_ONLY') {
      finalTxnId = 'IMG-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    }
    const { error } = await sb.from('deposits').insert({
      user_id: req.user.id, user_name: req.user.phone, phone: req.user.phone,
      method, amount, transaction_id: finalTxnId, screenshot: screenshot || null, status: 'pending'
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/deposits', auth, adminOnly, async (req, res) => {
  try {
    let query = sb.from('deposits').select('*, users!inner(name, phone, branch_id)').order('created_at', { ascending: false });
    if (req.user.role === 'branch') query = query.eq('users.branch_id', req.user.id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ deposits: (data || []).map(d => ({ ...d, user_name: d.users?.name || 'Unknown', phone: d.users?.phone || d.phone })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    let query = sb.from('withdrawals').select('*, users!inner(name, phone, branch_id)').order('created_at', { ascending: false });
    if (req.user.role === 'branch') query = query.eq('users.branch_id', req.user.id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ withdrawals: (data || []).map(w => ({ ...w, user_name: w.users?.name || 'Unknown', phone: w.users?.phone || w.phone })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const { action } = req.body;
    const { data: w } = await sb.from('withdrawals').select('*').eq('id', req.params.id).maybeSingle();
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    if (action === 'approve') {
      const { data: user } = await sb.from('users').select('balance').eq('id', w.user_id).maybeSingle();
      if (Number(user.balance) < Number(w.amount)) return res.status(400).json({ error: 'User has insufficient balance now' });
      await sb.from('users').update({ balance: Number(user.balance) - Number(w.amount) }).eq('id', w.user_id);
      await sb.from('withdrawals').update({ status: 'approved' }).eq('id', w.id);
    } else {
      await sb.from('withdrawals').update({ status: 'rejected' }).eq('id', w.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/decide', auth, adminOnly, async (req, res) => {
  try {
    const { action } = req.body;
    const { data: d } = await sb.from('deposits').select('*').eq('id', req.params.id).maybeSingle();
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    
    if (action === 'approve') {
      const { data: user } = await sb.from('users').select('balance').eq('id', d.user_id).maybeSingle();
      await sb.from('users').update({ balance: Number(user.balance) + Number(d.amount) }).eq('id', d.user_id);
      await sb.from('deposits').update({ status: 'approved' }).eq('id', d.id);
    } else {
      await sb.from('deposits').update({ status: 'rejected' }).eq('id', d.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   HISTORY
   ============================================================ */
app.get('/api/rounds', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    let q = sb.from('round_history').select('*').eq('game_type', 'wheel').order('created_at', { ascending: false }).limit(50);
    if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
    else q = q.is('branch_id', null);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ rounds: data || [] });
  } catch (e) { res.json({ rounds: [] }); }
});
app.get('/api/nb/rounds', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    let q = sb.from('round_history').select('*').eq('game_type', 'nb').order('created_at', { ascending: false }).limit(50);
    if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
    else q = q.is('branch_id', null);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ rounds: data || [] });
  } catch (e) { res.json({ rounds: [] }); }
});

app.delete('/api/admin/rounds/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: row } = await sb.from('round_history').select('branch_id').eq('id', req.params.id).maybeSingle();
    if (req.user.role === 'branch' && row?.branch_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your branch record' });
    }
    const { error } = await sb.from('round_history').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/nb/rounds/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: row } = await sb.from('round_history').select('branch_id').eq('id', req.params.id).maybeSingle();
    if (req.user.role === 'branch' && row?.branch_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your branch record' });
    }
    const { error } = await sb.from('round_history').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   WHEEL ADMIN
   ============================================================ */
app.post('/api/admin/spin/start', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const s = await getSettings(branchId);
    const tickets = await getTickets(branchId);
    const sold = tickets.filter(t => t.user_id || t.user_name || t.phone);
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
      winnersList.push({
        place: i + 1, name: t.user_name,
        phone_masked: t.phone ? t.phone.slice(0, 3) + '***' + t.phone.slice(-3) : '—',
        public_code: t.user_id ? 'U' + String(t.user_id).padStart(5, '0') : '—',
        ticket: t.ticket_number, prize
      });
      if (prize > 0 && t.user_id) {
        const { data: user } = await sb.from('users').select('balance').eq('id', t.user_id).maybeSingle();
        if (user) await sb.from('users').update({ balance: Number(user.balance) + prize }).eq('id', t.user_id);
      }
    }

    const firstWinnerTicket = winnersList[0].ticket;
    const winnerIndex = sold.findIndex(t => t.ticket_number === firstWinnerTicket);
    const anglePerSection = 360 / sold.length;
    const targetRotation = 360 - (winnerIndex * anglePerSection) - (anglePerSection / 2);

    const now = new Date().toISOString();

    await updateSettings(branchId, {
      round_state: 'spinning', 
      spin_started_at: now, 
      target_rotation: targetRotation, 
      winner_numbers: winnersList.map(w => w.ticket), 
      winners: winnersList
    });
    
    const historyTickets = sold.map(t => ({
      number: t.ticket_number,
      batch_id: t.batch_id,
      user_name: t.user_name,
      phone: t.phone
    }));

    await sb.from('round_history').insert({
      game_type: 'wheel', round_number: s.round_number, branch_id: branchId, winners: winnersList, tickets: historyTickets
    });
    
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spin/settle', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const s = await getSettings(branchId);
    if (s.round_state === 'spinning') {
      await updateSettings(branchId, { round_state: 'finished', spin_started_at: null });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/round/reset', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const s = await getSettings(branchId);
    let delQ = sb.from('tickets').delete().eq('round_number', s.round_number);
    delQ = scopeQuery(delQ, branchId);
    await delQ;
    await updateSettings(branchId, {
      round_number: Number(s.round_number) + 1, sales_state: 'open', round_state: 'idle',
      winner_numbers: [], winners: [], target_rotation: 0, spin_started_at: null, sales_started_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   NB ADMIN & STATE
   ============================================================ */
app.get('/api/nb/state', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const settings = await getNbSettings(branchId);
    const tickets = await getNbTickets(branchId, settings.round_number);

    let sold_count = 0;
    if (tickets.length > 0) {
      const uniqueNumbers = new Set(tickets.map(t => t.number));
      sold_count = uniqueNumbers.size;
    }
    
    let my_tickets = [];
    if (req.user.role === 'user') {
       my_tickets = tickets.filter(t => String(t.user_id) === String(req.user.id));
    }

    res.json({ 
      settings, 
      tickets: tickets, 
      my_tickets: my_tickets,
      sold_count: sold_count
    });
  } catch (e) { 
    console.error("🔥 NB STATE ERROR:", e); 
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/admin/nb/start-sales', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    await updateSettings(branchId, { sales_state: 'open', sales_started_at: new Date().toISOString() }, 'nb_settings');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/close-sales', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    await updateSettings(branchId, { sales_state: 'closed' }, 'nb_settings');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/draw', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const s = await getNbSettings(branchId);
    const allNums = Array.from({ length: s.total_numbers }, (_, i) => i + 1);
    const winning = allNums.sort(() => Math.random() - 0.5).slice(0, s.drawn_count);
    await updateSettings(branchId, {
      round_state: 'drawing', drawing_started_at: new Date().toISOString(), winning_numbers: winning
    }, 'nb_settings');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/nb/new-round', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const s = await getNbSettings(branchId);
    await updateSettings(branchId, {
      round_number: Number(s.round_number) + 1, sales_state: 'idle', round_state: 'idle',
      winning_numbers: [], winners: []
    }, 'nb_settings');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nb/settle', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const s = await getNbSettings(branchId);
    if (s.round_state !== 'drawing') return res.json({ ok: true });

    const elapsed = (Date.now() - new Date(s.drawing_started_at).getTime()) / 1000;
    const totalDrawTime = s.drawn_count * s.draw_delay_seconds;

    if (elapsed >= totalDrawTime) {
      const tickets = await getNbTickets(branchId, s.round_number);
      const winnersList = [];
      const userMatches = {};
      const uniqueUsers = new Set(tickets.map(t => t.user_id).filter(Boolean));

      for (const uid of uniqueUsers) {
        const userTickets = tickets.filter(t => t.user_id === uid);
        let matchCount = 0; const matchedNums = [];
        for (const t of userTickets) {
          if (s.winning_numbers.includes(t.number)) { matchCount++; matchedNums.push(t.number); }
        }
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
        winnersList.push({
          user_id: w.user.user_id, name: w.user.user_name,
          phone_masked: w.user.phone ? w.user.phone.slice(0, 3) + '***' + w.user.phone.slice(-3) : '—',
          public_code: 'U' + String(w.user.user_id).padStart(5, '0'),
          matches: w.count, shown_numbers: w.nums, prize, place: i + 1
        });
        if (prize > 0) {
          const { data: user } = await sb.from('users').select('balance').eq('id', w.user.user_id).maybeSingle();
          if (user) await sb.from('users').update({ balance: Number(user.balance) + prize }).eq('id', w.user.user_id);
        }
      }
      await updateSettings(branchId, { round_state: 'finished', winners: winnersList }, 'nb_settings');
      
      const historyTickets = tickets.map(t => ({
        number: t.number,
        batch_id: t.batch_id,
        user_name: t.user_name,
        phone: t.phone
      }));

      await sb.from('round_history').insert({
        game_type: 'nb', round_number: s.round_number, branch_id: branchId,
        winners: winnersList, winning_numbers: s.winning_numbers, tickets: historyTickets
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/auto-check', auth, async (req, res) => {
  try {
    const branchId = await resolveBranchId(req);
    const s = await getNbSettings(branchId);
    if (s.round_state === 'drawing') {
      const elapsed = (Date.now() - new Date(s.drawing_started_at).getTime()) / 1000;
      if (elapsed >= (s.drawn_count * s.draw_delay_seconds)) {
        await fetch(`http://localhost:${process.env.PORT || 3000}/api/nb/settle`, {
          method: 'POST',
          headers: { 'Authorization': req.headers.authorization, 'Content-Type': 'application/json' }
        });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

/* ============================================================
   ADMIN SETTINGS
   ============================================================ */
app.post('/api/admin/settings', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const { duration, winners, ticketPrice, referralGoal, referralReward, prizePercents, usePercentPrizes, salesDuration } = req.body;
    const patch = {};
    if (duration !== undefined) patch.duration_seconds = Number(duration);
    if (winners !== undefined) patch.winner_count = Number(winners);
    if (ticketPrice !== undefined) patch.ticket_price = Number(ticketPrice);
    if (referralGoal !== undefined) patch.referral_goal = Number(referralGoal);
    if (referralReward !== undefined) patch.referral_reward = Number(referralReward);
    if (prizePercents !== undefined) patch.prize_percents = prizePercents;
    if (salesDuration !== undefined) patch.sales_duration = Number(salesDuration);
    await updateSettings(branchId, patch);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/nb/settings', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const { total_numbers, drawn_count, tickets_per_purchase, price_per_purchase,
            draw_delay_seconds, round_duration_minutes, duration_minutes,
            winner_count, prize_percents, use_percent_prizes } = req.body;
    const patch = {
      total_numbers: Number(total_numbers),
      drawn_count: Number(drawn_count),
      tickets_per_purchase: Number(tickets_per_purchase),
      price_per_purchase: Number(price_per_purchase),
      draw_delay_seconds: Number(draw_delay_seconds),
      round_duration_minutes: Number(round_duration_minutes ?? duration_minutes),
      winner_count: Number(winner_count),
      prize_percents
    };
    await updateSettings(branchId, patch, 'nb_settings');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tickets/count', auth, adminOnly, async (req, res) => {
  try {
    const branchId = adminBranchScope(req);
    const count = Number(req.body.count);
    if (!Number.isFinite(count) || count < 2 || count > 60) {
      return res.status(400).json({ error: 'Count must be 2-60' });
    }
    await updateSettings(branchId, { ticket_count: count });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   ADMIN: CHANGE PASSWORD
   ============================================================ */
app.post('/api/admin/change-password', auth, adminOnly, async (req, res) => {
  try {
    const { newPassword, code } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    if (!code) {
      return res.status(400).json({ error: 'Secret Reset Code is required' });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    if (req.user.role === 'branch') {
      const { error } = await sb.from('branches').update({ password_hash: hash }).eq('id', req.user.id);
      if (error) throw error;
      res.json({ ok: true });
    } else {
      const { error } = await sb.from('users').update({ password_hash: hash }).eq('id', req.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   AI CHAT
   ============================================================ */
app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not found in .env' });
    const { message } = req.body;
    const isAdmin = ['admin', 'main_admin', 'branch'].includes(req.user.role);
    const systemPrompt = isAdmin ? `You are the Teshe Betting Admin Assistant.` : `You are the Teshe Betting Customer Support AI.`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
        temperature: 0.5
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'AI failed to respond');
    res.json({ reply: data.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   START
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));