// Overseer's service worker: push notifications only. It caches nothing, so a reload always gets the current app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = { title: 'Overseer', body: '', url: '#board' };
  try { m = { ...m, ...e.data.json() }; } catch { /* a payload that is not JSON shows as the default */ }
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, data: { url: m.url }, tag: m.url, renotify: true }));
});

// A tap focuses the open app on the matching view, or opens one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? '#board', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    const w = all[0];
    if (w) return w.navigate(url).then((x) => (x ?? w).focus());
    return self.clients.openWindow(url);
  }));
});
