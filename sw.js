// Service worker ExoFeed Control.
// ВАЖНО: кэш здесь — это только файлы приложения (HTML/иконки/манифест).
// localStorage (база животных) — отдельное, полностью независимое хранилище браузера,
// service worker и его кэш его никогда не читают, не пишут и не удаляют.

const CACHE_NAME = 'exofeed-shell-v1.5.5';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .catch(() => {}) // не роняем установку, если какой-то ресурс временно недоступен
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Саму страницу (index.html) всегда стараемся взять свежую из сети — чтобы после обновления
  // файла на GitHub Pages пользователь как можно быстрее увидел новую версию. Офлайн — отдаём кэш.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }
  // Остальные ресурсы (иконки, манифест) — кэш в приоритете, сеть как резерв
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
