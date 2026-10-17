// تفعيل الإشعارات للراكب والكابتن والأدمن
(function () {
  const VAPID_PUB = 'BBvHbaXHHDeP3Ep-e_qtz6DizNhzMgUOFwCPHBg599Fr99-iWTlMknPN0py5ZrTGWvcMAfzYM1RAN7NIK9sSW4o';
  const u8 = b64 => { const p = '='.repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  const isAdminView = () => window.FORCE_ADMIN === true || location.hash === '#admin-x7k29q';

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return alert('المتصفح ده مش بيدعم الإشعارات. على آيفون: ثبّت التطبيق على الشاشة الرئيسية الأول (Add to Home Screen) وافتحه منها.');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return alert('لازم توافق على الإشعارات عشان توصلك');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(VAPID_PUB) });
    let who, ref = '', headers = { 'Content-Type': 'application/json' };
    if (isAdminView()) { who = 'admin'; headers['x-admin-pin'] = window.adminPin || ''; }
    else {
      const role = curRole();
      if (role === 'rider') { who = 'rider'; ref = (S.riders.find(x => x.id === riderId) || {}).phone || ''; }
      else if (role === 'driver') { who = 'driver'; ref = (S.drivers.find(x => x.id === driverId) || {}).phone || ''; }
      else return alert('سجّل دخولك الأول عشان نفعّل الإشعارات ليك');
    }
    const r = await fetch('/api/push-subscribe', { method: 'POST', headers, body: JSON.stringify({ who, ref, sub: sub.toJSON() }) });
    alert(r.ok ? 'تم تفعيل الإشعارات ✓' : 'حصلت مشكلة في التفعيل، جرّب تاني');
  }
  window.enablePush = enablePush;

  // زرار في القايمة (☰) للراكب والكابتن
  const _openDrawer = window.openDrawer;
  window.openDrawer = function () {
    _openDrawer();
    const box = document.getElementById('drawerIn');
    if (!box || box.querySelector('#pushBtn')) return;
    const b = document.createElement('button');
    b.id = 'pushBtn'; b.className = 'dr-i'; b.textContent = '🔔 فعّل الإشعارات';
    b.onclick = () => { closeDrawer(); enablePush(); };
    box.insertBefore(b, box.querySelector('.dr-i.red'));
  };

  // زرار للأدمن في أعلى الصفحة
  const addAdminBtn = () => {
    const app = document.getElementById('app');
    if (!app || !isAdminView() || !window.adminOK || document.getElementById('pushAdmin')) return;
    const b = document.createElement('button');
    b.id = 'pushAdmin'; b.className = 'btn'; b.style.margin = '0 0 14px'; b.textContent = '🔔 فعّل إشعارات الأدمن';
    b.onclick = enablePush;
    app.insertBefore(b, app.firstChild);
  };
  new MutationObserver(addAdminBtn).observe(document.body, { childList: true, subtree: true });
})();
