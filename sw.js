// 第二大脑 Service Worker —— 离线优先 + 永远拉最新
//
// 设计目标（对齐 server.py 的 no-store 约定，化解当年「缓存导致看不到更新」的坑）：
//   1. 离线可用：应用壳与静态资源缓存到本地，断网也能打开应用、读 IndexedDB 本地数据。
//   2. 永远最新：HTML 走「网络优先」，在线必定拿到新版本；静态资源用 ?v= 版本化，
//      换版本 = 换 URL = 自动命中新缓存，旧缓存由 CACHE_VERSION 统一清理。
//   3. 同步/接口不缓存：/api/* 与任何非 GET 请求一律走网络，杜绝离线假同步、假数据。
//   4. 即时生效：skipWaiting + clients.claim，新 SW 安装后立刻接管页面，用户无需手动刷新。

const CACHE_VERSION = 'wb-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

// 安装：预缓存应用壳（失败不致命，运行时还会按需补缓存）
self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return Promise.all(APP_SHELL.map(function (u) {
        return cache.add(new Request(u, { cache: 'no-cache' })).catch(function () { /* 单个失败忽略 */ });
      }));
    })
  );
});

// 激活：清理旧版本缓存 + 立即接管所有页面
self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;

  // 非 GET（如同步 POST /api/sync、消化 POST /api/digest）→ 直接走网络，绝不缓存
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 接口/同步类请求：永远走网络，不缓存、不返回旧响应（防离线假数据）
  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(fetch(req));
    return;
  }

  // 页面导航：网络优先，离线时回退到缓存的应用壳（保证断网也能开 app）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  // 静态资源（JS/CSS/图片/字体等）：缓存优先
  // 安全原因：本项目静态资源均带 ?v= 版本号，换版本即换 URL，天然不会命中旧缓存。
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 离线且该项从未缓存过（极少发生，因通常先在线加载一次）：返回空响应，不阻塞其它资源
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
