// Service worker: يخزّن ملفات الواجهة عشان تفتح بسرعة وتشتغل من غير ما الموبايل يبقى فيه نت كويس.
// الـ API (/api/) مابيتخزنش أبداً: الداتا لازم تيجي طازة.
const CACHE = 'tawseela-v3';
const SHELL = ['/', '/tawseela.html', '/admin.html', '/manifest.json', '/manifest-admin.json', '/icon-192.png', '/icon-512.png', '/admin-192.png', '/admin-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // الصفحة الرئيسية: الشبكة الأول، ولو مافيش نت نرجع للنسخة المخزنة
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/tawseela.html')));
    return;
  }
  // باقي الملفات: من الكاش، ونحدّثه في الخلفية
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// ---------- إشعارات الدفع (حتى لو التطبيق مقفول) ----------
self.addEventListener('push', e => {
  let d = { title: 'توصيلة', body: '' };
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'توصيلة', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', dir: 'rtl', lang: 'ar', data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || '/'));
});
