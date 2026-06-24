// PWA lifecycle only. Android's verified asset store owns caching; registering
// a no-op fetch handler adds navigation overhead in WebView.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
