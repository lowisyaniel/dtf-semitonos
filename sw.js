// Service worker de DTF Semitonos.
// - Guarda la página para que abra sin internet (primero la red, si no hay, lo guardado).
// - Le pone a todo las cabeceras COOP/COEP: sin ellas Chrome no deja usar
//   varios hilos y la IA en el procesador va mucho más lenta.
// Los modelos NO pasan por aquí: ia.js los guarda en su propia caché.
const VERSION = 'dtf-pagina-v1';
const PAGINA = ['./', 'index.html', 'estilo.css', 'app.js', 'semitono.js', 'png.js', 'ia.js', 'registro.js',
  'manifest.webmanifest', 'icono-192.png', 'icono-512.png',
  'ort/ort.webgpu.bundle.min.mjs', 'ort/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PAGINA)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('dtf-pagina-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function aislar(r) {
  if (!r || r.status === 0 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/modelos/')) return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) {
        const c = await caches.open(VERSION);
        c.put(e.request, r.clone()).catch(() => {});
      }
      return aislar(r);
    } catch (err) {
      const guardado = await caches.match(e.request, { ignoreSearch: true });
      if (guardado) return aislar(guardado);
      throw err;
    }
  })());
});
