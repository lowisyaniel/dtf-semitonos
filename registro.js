// Lo que la hace "app de Chrome": el service worker (abre sin internet y
// activa los hilos de la IA) y el botón "Instalar app".
'use strict';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    // Los hilos de la IA necesitan que la página venga con las cabeceras del
    // service worker; la primera visita llega sin ellas: se recarga una vez.
    if (!self.crossOriginIsolated && !sessionStorage.getItem('dtf-recargada')) {
      sessionStorage.setItem('dtf-recargada', '1');
      if (!document.querySelector('[data-necesita-imagen]:not(.apagado)')) location.reload();
    }
  }).catch(() => { /* sin service worker: funciona igual, sin modo sin internet */ });
}

let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  pedidoInstalar = e;
  document.getElementById('instalar').hidden = false;
});
document.getElementById('instalar').addEventListener('click', async () => {
  if (!pedidoInstalar) return;
  pedidoInstalar.prompt();
  await pedidoInstalar.userChoice;
  pedidoInstalar = null;
  document.getElementById('instalar').hidden = true;
});
window.addEventListener('appinstalled', () => { document.getElementById('instalar').hidden = true; });
