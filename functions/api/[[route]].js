// Cloudflare Pages Function: يشتغل على /api/* ويخزّن الداتا في D1 (مع ترحيل تلقائي من KV مرة واحدة)
// الربط المطلوب في إعدادات المشروع:
//   D1 database binding:   DB        ->  tawseela-db
//   KV namespace binding:  TAWSEELA  ->  (للترحيل من الداتا القديمة فقط)
//   Environment variable:  ADMIN_PIN ->  الرمز السري للأدمن (Secret)

const COLL = ['riders', 'drivers', 'trips', 'payments', 'msgs', 'announcements'];
const KEY = 'db';
const DEFAULT_CATS = [
  { id: 'eco', name: 'اقتصادي', desc: '٤ ركاب • الأوفر', extra: 0 },
  { id: 'comfort', name: 'مريح', desc: '٤ ركاب • عربية أحدث وأريح', extra: 10 },
  { id: 'family', name: 'عائلي', desc: '٦ ركاب • عربية كبيرة', extra: 20 },
  { id: 'moto', name: 'موتوسيكل', desc: 'راكب واحد • الأسرع في الزحمة', extra: -5 }
];
const DEMO_ID = 9001; // رقم ثابت للكابتن التجريبي عشان ميتغيّرش بين الطلبات
const uid = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

function fresh() {
  return {
    settings: { base: 30, stop: 5, sub: 100, cats: DEFAULT_CATS.map(c => ({ ...c })),
      wallets: { vodafone: '01000000000', orange: '01200000000', etisalat: '01100000000', instapay: 'yourname@instapay' } },
    buildings: [], coords: {},
    riders: [], trips: [], payments: [], msgs: [], announcements: [], drivers: []
  };
}

function normalize(DB) {
  for (const c of COLL) DB[c] = DB[c] || [];
  DB.coords = DB.coords || {};
  if (!DB.settings.cats) DB.settings.cats = DEFAULT_CATS.map(c => ({ ...c }));
  if (!DB.settings.cats.some(c => c.id === 'moto')) DB.settings.cats.push({ id: 'moto', name: 'موتوسيكل', desc: 'راكب واحد • الأسرع في الزحمة', extra: -5 });
  DB.drivers.forEach(d => { if (!d.cat) d.cat = 'eco'; });
  // السواق التجريبي اتمسح من النظام كله: نشيل أي حساب تجريبي قديم
  DB.drivers = DB.drivers.filter(d => d.phone !== '01000000001' && d.phone !== '01000000002');
  // الرسايل القديمة اللي كانت في الإعدادات تتنقل لقايمتها الخاصة
  if (Array.isArray(DB.settings.announcements) && DB.settings.announcements.length) {
    const have = new Set(DB.announcements.map(a => a.id));
    DB.announcements = DB.announcements.concat(DB.settings.announcements.filter(a => !have.has(a.id)));
    delete DB.settings.announcements;
  }
  DB.buildings = (DB.buildings || []).filter(b => /^(block|u|t)[|]/.test(b));
  return DB;
}

// التخزين على D1: جدول واحد بيحفظ الداتا (المفتاح + القيمة JSON)
async function dbRead(env) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(KEY).first();
  return row ? JSON.parse(row.value) : null;
}
async function dbWrite(env, DB) {
  await env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(KEY, JSON.stringify(DB)).run();
}
async function load(env) {
  let db = await dbRead(env);
  if (!db) {
    // ترحيل لمرة واحدة: لو فيه داتا قديمة في KV ننقلها لـ D1، ولو مفيش نبدأ بداتا جديدة
    const old = env.TAWSEELA ? await env.TAWSEELA.get(KEY, 'json') : null;
    db = normalize(old || fresh());
    await dbWrite(env, db);
  }
  return normalize(db);
}

const pinOf = env => env.ADMIN_PIN || '1234';
const isAdmin = (req, env) => req.headers.get('x-admin-pin') === pinOf(env);

// الحظر: بيمنع نفس الرقم أو نفس الاسم أو نفس البطاقة لحد ما المدة تخلص (0 = نهائي)
function isBlocked(DB, d) {
  const now = Date.now();
  return (DB.settings.blocks || []).some(b =>
    (!b.until || b.until > now) && (
      (b.phone && d.phone && b.phone === d.phone) ||
      (b.nid && d.nid && b.nid === d.nid) ||
      (b.name && d.name && b.name.trim() === d.name.trim())));
}

function view(DB, admin) {
  const out = JSON.parse(JSON.stringify(DB));
  if (!admin) out.drivers = out.drivers.filter(d => !isBlocked(DB, d)).map(d => ({ ...d, photos: {}, nid: '' }));
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
  if (admin && b.removed && Array.isArray(b.removed.drivers)) DB.drivers = DB.drivers.filter(x => !b.removed.drivers.includes(x.id));
  if (admin && b.removedRec && typeof b.removedRec === 'object') {
    for (const c of ['riders','trips','payments','msgs']) {
      const ids = Array.isArray(b.removedRec[c]) ? b.removedRec[c] : [];
      if (ids.length) DB[c] = DB[c].filter(x => !ids.includes(x.id));
    }
  }
  const up = b.upserts || {};
  for (const c of COLL) {
    for (const item of up[c] || []) {
      if (!item || typeof item.id !== 'number') continue;
      const i = DB[c].findIndex(x => x.id === item.id);
      if (c === 'drivers') {
        if (i >= 0) {
          if (admin) DB.drivers[i] = item;
          // الكابتن يقدر يصحّح بياناته لو اتراجعت (مش موافق عليه)، ويرجع للمراجعة تاني
          else if (DB.drivers[i].status === 'approved' && DB.drivers[i].phone === item.phone && !isBlocked(DB, item)) {
            // المقبول يقدر يغيّر صورة البروفايل وبيانات الدفع بتاعته بس
            const upd = { ...DB.drivers[i] };
            if (item.avatar) upd.avatar = item.avatar;
            if (item.pay && typeof item.pay === 'object') upd.pay = { wallet: String(item.pay.wallet || '').slice(0, 20), insta: String(item.pay.insta || '').slice(0, 60) };
            DB.drivers[i] = upd;
          }
          else if (DB.drivers[i].status !== 'approved' && DB.drivers[i].phone === item.phone && !isBlocked(DB, item))
            DB.drivers[i] = { ...item, id: DB.drivers[i].id, status: 'pending', subUntil: 0, reason: undefined, faceMatch: undefined, trialMsg: false };
        }
        else if (!isBlocked(DB, item) && !DB.drivers.some(x => x.phone === item.phone || (item.nid && x.nid === item.nid)))
          DB.drivers.push(admin ? item : { ...item, status: 'pending', subUntil: 0 });
      } else if (c === 'payments') {
        if (i >= 0) { if (admin) DB.payments[i] = item; }
        else DB.payments.push(admin ? item : { ...item, status: 'review' });
      } else if (c === 'trips') {
        if (i >= 0) {
          const old = DB.trips[i];
          // منع كباتن اتنين من قبول نفس الرحلة
          if (old.driverId && item.driverId && old.driverId !== item.driverId && item.status === 'accepted') continue;
          DB.trips[i] = item;
        } else DB.trips.push(item);
      } else if (c === 'msgs') {
        if (i < 0) DB.msgs.push({ ...item, text: String(item.text || '').slice(0, 300) });
      } else {
        if (c === 'announcements' && !admin) continue;
        if (i >= 0) DB[c][i] = item; else DB[c].push(item);
      }
    }
  }
}

// ---------- الإشعارات (Web Push) ----------
const b64u = {
  enc: buf => { let x=''; for (const c of new Uint8Array(buf)) x+=String.fromCharCode(c); return btoa(x).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); },
  dec: str => { const pad=(4-str.length%4)%4; const x=atob((str+'='.repeat(pad)).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(x,c=>c.charCodeAt(0)); }
};
const enc8 = s => new TextEncoder().encode(s);
const cat = (...a) => { const n=a.reduce((x,y)=>x+y.length,0); const o=new Uint8Array(n); let p=0; for (const x of a) { o.set(x,p); p+=x.length; } return o; };
async function hkdf(ikm, salt, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info }, k, len*8));
}
// توقيع VAPID (JWT بمفتاح ES256)
async function vapidJwt(env, aud) {
  const hdr = b64u.enc(enc8(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const pl = b64u.enc(enc8(JSON.stringify({ aud, exp: Math.floor(Date.now()/1000)+12*3600, sub: env.VAPID_SUBJECT })));
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const key = await crypto.subtle.importKey('jwk', { kty:'EC', crv:'P-256', d: env.VAPID_PRIVATE, x: b64u.enc(pub.slice(1,33)), y: b64u.enc(pub.slice(33,65)), ext:true }, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc8(hdr+'.'+pl));
  return hdr+'.'+pl+'.'+b64u.enc(sig);
}
// تشفير الرسالة (aes128gcm حسب معيار Web Push)
async function encryptPayload(sub, text) {
  const ua = b64u.dec(sub.p256dh), auth = b64u.dec(sub.auth);
  const eph = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public: uaKey }, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(shared, auth, cat(enc8('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(prk, salt, enc8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(prk, salt, enc8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, key, cat(enc8(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0,0,16,0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);
  const r = await fetch(sub.endpoint, { method:'POST', headers: {
    TTL:'86400', 'Content-Encoding':'aes128gcm', 'Content-Type':'application/octet-stream',
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` }, body });
  if (r.status === 404 || r.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
  return r.status;
}
// بيبعت لكل أجهزة شخص (who + ref). ref للراكب والكابتن = رقم التليفون، والأدمن = 'admin'
async function notify(env, who, ref, title, body) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE || !env.DB) return;
  const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE who = ? AND ref = ?').bind(who, String(ref)).all();
  for (const sub of (rows.results || [])) {
    try { await sendPush(env, sub, { title, body, url: '/' }); } catch (e) { /* نكمّل للباقي */ }
  }
}
// الأحداث اللي بتبعت إشعارات: بنقارن الداتا قبل وبعد التحديث
async function pushEvents(env, before, DB) {
  const jobs = [];
  // أي رسالة جديدة في صفحة التحديثات بتتبعت إشعار للكل
  const seenAnn = new Set(before.ann || []);
  for (const a of (DB.announcements || [])) {
    if (seenAnn.has(a.id)) continue;
    const body = (a.text || '').slice(0, 140) || 'فيه تحديث جديد، افتح التحديثات';
    jobs.push(broadcast(env, { title: 'رسالة من الإدارة', body, url: '/' }));
  }
  const rider = id => DB.riders.find(r => r.id === id);
  const drv = id => DB.drivers.find(d => d.id === id);
  for (const d of DB.drivers) {
    const prev = before.drivers[d.id];
    if (!prev) { if (d.status === 'pending') jobs.push(notify(env,'admin','admin','توصيلة','كابتن جديد عايز يدخل: ' + d.name)); continue; }
    if (prev !== d.status && (d.status === 'approved' || d.status === 'rejected'))
      jobs.push(notify(env,'driver',d.phone,'توصيلة', d.status === 'approved' ? 'تمام! بياناتك اتأكدت، تقدر تبدأ تشتغل' : 'محتاجين تصحيح في بياناتك: ' + (d.reason || 'راجع بياناتك')));
  }
  for (const t of DB.trips) {
    const prev = before.trips[t.id];
    if (!prev || prev.status === t.status) continue;
    const r = rider(t.riderId), d = drv(t.driverId);
    if (t.status === 'accepted' && r) jobs.push(notify(env,'rider',r.phone,'توصيلة','الكابتن ' + (d ? d.name : '') + ' وافق على طلبك'));
    if (t.status === 'arrived' && r) jobs.push(notify(env,'rider',r.phone,'توصيلة','الكابتن وصل عندك'));
    if (t.status === 'done' && r) jobs.push(notify(env,'rider',r.phone,'توصيلة','انتهت الرحلة، شكراً ليك'));
    if (t.status === 'cancelled') {
      const c = (t.cancel || []).slice(-1)[0];
      const reason = c ? (c.name + ': ' + c.reason) : '';
      if (c && c.by === 'rider' && d) jobs.push(notify(env,'driver',d.phone,'توصيلة','الراكب ألغى الرحلة ' + reason));
      if (c && c.by === 'driver' && r) jobs.push(notify(env,'rider',r.phone,'توصيلة','الكابتن ألغى الرحلة ' + reason));
    }
  }
  await Promise.all(jobs);
}
async function broadcast(env, payload) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE || !env.DB) return;
  const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs').all();
  for (const sub of (rows.results || [])) { try { await sendPush(env, sub, payload); } catch (e) { /* نكمّل */ } }
}
function snapshot(DB) {
  const before = { drivers:{}, trips:{}, ann: (DB.announcements || []).map(a => a.id) };
  for (const d of DB.drivers) before.drivers[d.id] = d.status;
  for (const t of DB.trips) before.trips[t.id] = { status: t.status };
  return before;
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
      const before = snapshot(DB);
      merge(DB, b, admin);
      await dbWrite(env, DB);
      const job = pushEvents(env, before, DB).catch(() => {});
      if (context.waitUntil) context.waitUntil(job);
      return json(view(DB, admin));
    }
    if (request.method === 'POST' && p === '/api/push-subscribe') {
      const b = await request.json().catch(() => ({}));
      const sub = b.sub || {}, keys = sub.keys || {};
      if (!sub.endpoint || !keys.p256dh || !keys.auth) return json({ error: 'bad subscription' }, 400);
      let who = String(b.who || ''), ref = String(b.ref || '');
      if (who === 'admin') { if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403); ref = 'admin'; }
      if (!['rider','driver','admin'].includes(who)) return json({ error: 'bad who' }, 400);
      if (who !== 'admin' && !ref) return json({ error: 'missing ref' }, 400);
      await env.DB.prepare('INSERT INTO push_subs (who, ref, endpoint, p256dh, auth) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET who=excluded.who, ref=excluded.ref, p256dh=excluded.p256dh, auth=excluded.auth')
        .bind(who, ref, sub.endpoint, keys.p256dh, keys.auth).run();
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e.message) }, 400);
  }
}
