// 最小透传 Service Worker：仅用于满足 PWA 安装要求（含 Web Share Target）。
// 不做任何缓存，所有请求直接转发，避免之前踩过的「缓存导致看不到更新」问题。
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
