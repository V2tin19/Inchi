/**
 * sw.js —— 理序的最简 Service Worker
 *
 * 只做一件事：把应用外壳（静态文件）缓存起来，手机加到主屏后断网也能打开骨架。
 * 铁律：/api/ 开头的请求永远直连网络，绝不缓存——账目数据的读写不能有任何陈旧副本。
 * 外壳策略 network-first：在线必拿最新代码（个人工具迭代快，最怕旧脚本配新后端），
 * 只有断网才回落缓存——离线时能打开骨架就够。
 */

const CACHE = 'cairn-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/workbench.js',
  '/notes.js',
  '/calendar.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;   // API 永远走网络
  if (url.origin !== location.origin) return;                                   // 只管自己的外壳

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
