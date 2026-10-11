// Cloudflare Pages Function: يشتغل على /api/* ويخزّن الداتا في KV
// الربط المطلوب في إعدادات المشروع:
//   KV namespace binding:  TAWSEELA  ->  (اسم الـ KV اللي عملته)
//   Environment variable:  ADMIN_PIN ->  الرمز السري للأدمن (Secret)

const COLL = ['riders', 'drivers', 'trips', 'payments', 'msgs'];
const KEY = 'db';
const DEFAULT_CATS = [
  { id: 'eco', name: 'اقتصادي', desc: '٤ ركاب • الأوفر', extra: 0 },
  { id: 'comfort', name: 'مريح', desc: '٤ ركاب • عربية أحدث وأريح', extra: 10 },
  { id: 'family', name: 'عائلي', desc: '٦ ركاب • عربية كبيرة', extra: 20 }
];
const uid = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

function fresh() {
  return {
    settings: { base: 30, stop: 5, sub: 100, cats: DEFAULT_CATS.map(c => ({ ...c })),
      wallets: { vodafone: '01000000000', orange: '01200000000', etisalat: '01100000000', instapay: 'yourname@instapay' } },
    buildings: [], coords: {},
    riders: [], trips: [], payments: [], msgs: [],
    drivers: [
      { id: uid(), name: 'سواق تجريبي (تجربة)', phone: '01000000002', license: 'DEMO', nid: '', cat: 'comfort', photos: {}, status: 'approved', subUntil: Date.now() + 90 * 864e5 },
      { id: uid(), name: 'سواق تجريبي ثلاثي', phone: '01000000001', license: '123456', nid: '29001010101010', cat: 'eco', photos: {}, status: 'approved', subUntil: Date.now() + 30 * 864e5 }
    ]
  };
}

function normalize(DB) {
  for (const c of COLL) DB[c] = DB[c] || [];
  DB.coords = DB.coords || {};
  if (!DB.settings.cats) DB.settings.cats = DEFAULT_CATS.map(c => ({ ...c }));
  DB.drivers.forEach(d => { if (!d.cat) d.cat = 'eco'; });
  if (!DB.drivers.some(d => d.phone === '01000000002'))
    DB.drivers.push({ id: uid(), name: 'سواق تجريبي (تجربة)', phone: '01000000002', license: 'DEMO', nid: '', cat: 'comfort', photos: {}, status: 'approved', subUntil: Date.now() + 90 * 864e5 });
  DB.buildings = (DB.buildings || []).filter(b => /^(block|u|t)[|]/.test(b));
  return DB;
}

async function load(env) {
  const db = await env.TAWSEELA.get(KEY, 'json');
  return normalize(db || fresh());
}

const pinOf = env => env.ADMIN_PIN || '1234';
const isAdmin = (req, env) => req.headers.get('x-admin-pin') === pinOf(env);

function view(DB, admin) {
  const out = JSON.parse(JSON.stringify(DB));
  if (!admin) out.drivers = out.drivers.map(d => ({ ...d, photos: {}, nid: '' }));
  return out;
}

function merge(DB, b, admin) {
  if (admin && b.settings) DB.settings = { ...DB.settings, ...b.settings };
  // إحداثيات العمارات: أول واحد يحفظها بيكسب، والأدمن يقدر يعدّل
  if (b.coords && typeof b.coords === 'object') {
    for (const k of Object.keys(b.coords)) {
      const v = b.coords[k];
      if (!Array.isArray(v) || v.length < 2 || !isFinite(v[0]) || !isFinite(v[1])) continue;
      if (!DB.coords[k] || admin) DB.coords[k] = v;
    }
  }
  if (admin && Array.isArray(b.buildings)) DB.buildings = b.buildings;
  const up = b.upserts || {};
  for (const c of COLL) {
    for (const item of up[c] || []) {
      if (!item || typeof item.id !== 'number') continue;
      const i = DB[c].findIndex(x => x.id === item.id);
      if (c === 'drivers') {
        if (i >= 0) { if (admin) DB.drivers[i] = item; }
        else if (!DB.drivers.some(x => x.phone === item.phone || (item.nid && x.nid === item.nid)))
          DB.drivers.push(admin ? item : { ...item, status: 'pending', subUntil: 0 });
      } else if (c === 'payments') {
        if (i >= 0) { if (admin) DB.payments[i] = item; }
        else DB.payments.push(admin ? item : { ...item, status: 'review' });
      } else if (c === 'trips') {
        if (i >= 0) {
          const old = DB.trips[i];
          // منع سواقين اتنين من قبول نفس الرحلة
          if (old.driverId && item.driverId && old.driverId !== item.driverId && item.status === 'accepted') continue;
          DB.trips[i] = item;
        } else DB.trips.push(item);
      } else if (c === 'msgs') {
        if (i < 0) DB.msgs.push({ ...item, text: String(item.text || '').slice(0, 300) });
      } else {
        if (i >= 0) DB[c][i] = item; else DB[c].push(item);
      }
    }
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).pathname;
  const json = (o, code = 200) => new Response(JSON.stringify(o), {
    status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
  try {
    if (request.method === 'GET' && p === '/api/state') {
      const DB = await load(env);
      return json(view(DB, isAdmin(request, env)));
    }
    if (request.method === 'POST' && p === '/api/admin-login') {
      const b = await request.json().catch(() => ({}));
      return json({ ok: b.pin === pinOf(env) });
    }
    if (request.method === 'POST' && p === '/api/sync') {
      const b = await request.json().catch(() => ({}));
      const admin = isAdmin(request, env);
      const DB = await load(env);
      merge(DB, b, admin);
      await env.TAWSEELA.put(KEY, JSON.stringify(DB));
      return json(view(DB, admin));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e.message) }, 400);
  }
}
