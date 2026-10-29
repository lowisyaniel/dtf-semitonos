import { codificarPNG } from './png.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const FORMAS = [
  ['redondo', 'Puntos'], ['clasico', 'Clásico'], ['cuadrado', 'Cuadros'], ['rombo', 'Rombos'],
  ['elipse', 'Cadena'], ['lineas', 'Líneas'], ['ondas', 'Ondas'], ['zigzag', 'Zigzag'],
  ['cruz', 'Cruces'], ['cuadricula', 'Cuadrícula'], ['anillos', 'Anillos'], ['triangulo', 'Triángulos'],
  ['estrella', 'Estrellas'], ['corazon', 'Corazones'], ['grano', 'Grano'], ['ruido', 'Grunge'],
  ['ninguno', 'Sin trama'],
];
const DE_CELDA = new Set(['redondo', 'clasico', 'cuadrado', 'rombo', 'elipse', 'cruz', 'triangulo', 'estrella', 'corazon']);
const DEFECTOS_MODO = {
  blanca: { corte: 235, solido: 40 },
  negra: { corte: 25, solido: 215 },
  alfa: {},
};

const S = {
  w: 0, h: 0, rgb: null, alfa: null, nombre: '',
  vista: 'imagen', fondo: 'cuadros',
  herr: 'mover', pincel: 60, tol: 10, contiguo: true,
  deshacer: [], rehacer: [],
  zoom: 1, cx: 0.5, cy: 0.5,
  imp: { ancho: 10, unidad: 'in', dpi: 300 },
  res: null,
  p: {
    modo: 'blanca', forma: 'redondo', estilo: 'detalle', trama: 0.73, tamPunto: 0, angulo: 22.5,
    corte: 235, solido: 40, invertir: false, respiracion: 0, saturacion: 0, contraste: 0, minPunto: 8, maxPunto: 92, limpieza: 4,
    alfaModo: 'umbral', alfaUmbral: 128, tinta: 'original', tintaColor: '#000000',
  },
};

// ---------- lienzos ----------
const lienzo = $('#lienzo');
const ctx = lienzo.getContext('2d');
const cBase = document.createElement('canvas'); // lo que se ve en "Original"
const cRGB = document.createElement('canvas');  // color sin transparencia (para reescalar limpio)
const cAlfa = document.createElement('canvas'); // transparencia en gris
const cRes = document.createElement('canvas');  // el resultado
const xBase = cBase.getContext('2d');
const xRGB = cRGB.getContext('2d');
const xAlfa = cAlfa.getContext('2d');
const xRes = cRes.getContext('2d');

const escapar = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hexARgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const redondo = (v, d = 1) => Number(v.toFixed(d));

// ---------- motor de semitonos ----------
const motor = new Worker('semitono.js');
let versionPedida = 1, versionHecha = 0, ocupado = false, fuenteSucia = true, forzar = false;
let esperando = [];
let temporizador = null;

let rapidoPedido = false;
function pedirResultado(rapido = false) {
  versionPedida++;
  rapidoPedido = rapido;
  clearTimeout(temporizador);
  temporizador = setTimeout(lanzar, 40);
}

function medidas() {
  const anchoIn = S.imp.unidad === 'cm' ? S.imp.ancho / 2.54 : S.imp.ancho;
  const pw = Math.max(1, Math.round(anchoIn * S.imp.dpi));
  const ph = Math.max(1, Math.round(pw * S.h / S.w));
  return { anchoIn, altoIn: ph / S.imp.dpi, pw, ph };
}

function parametrosMotor() {
  const p = S.p;
  return {
    ...p,
    celda: S.imp.dpi * p.trama / 25.4,
    minPunto: p.minPunto / 100,
    maxPunto: p.maxPunto / 100,
    respiracion: p.respiracion / 100,
    saturacion: p.saturacion / 100,
    contraste: p.contraste / 100,
    tintaColor: hexARgb(p.tintaColor),
  };
}

function enviarFuente() {
  const { pw, ph } = medidas();
  const leer = (origen) => {
    const c = new OffscreenCanvas(pw, ph);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(origen, 0, 0, pw, ph);
    return x.getImageData(0, 0, pw, ph).data;
  };
  const d = leer(cRGB);
  const a = leer(cAlfa);
  for (let i = 3; i < d.length; i += 4) d[i] = a[i - 3];
  motor.postMessage({ tipo: 'fuente', w: pw, h: ph, buf: d.buffer }, [d.buffer]);
}

function lanzar() {
  if (ocupado || !S.rgb) return;
  if (S.vista !== 'resultado' && !forzar) return;
  if (versionHecha === versionPedida && !fuenteSucia) return;
  const { pw, ph } = medidas();
  if (pw * ph > 110e6) {
    estado(`Demasiado grande (${pw}×${ph} px). Baja el ancho o los DPI.`);
    return;
  }
  ocupado = true;
  $('#calculando').hidden = false;
  if (fuenteSucia) { enviarFuente(); fuenteSucia = false; }
  motor.postMessage({ tipo: 'procesar', id: versionPedida, rapido: rapidoPedido && pw * ph > 3e6, p: parametrosMotor() });
}

motor.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'muestras') return pintarMuestras(m);
  ocupado = false;
  versionHecha = m.id;
  S.res = { w: m.w, h: m.h, datos: new Uint8ClampedArray(m.buf), info: m.info, rapido: m.rapido };
  cRes.width = m.w; cRes.height = m.h;
  xRes.putImageData(new ImageData(S.res.datos, m.w, m.h), 0, 0);
  const i = m.info;
  const pct = redondo(i.conTinta / i.total * 100, 1);
  estado(`${m.rapido ? 'Vista rápida · ' : ''}${m.w}×${m.h} px · tinta ${pct}% · ${i.motas} motas quitadas · ${i.huecos} huequitos tapados · ${m.info.ms} ms`);
  if (versionHecha !== versionPedida || fuenteSucia) {
    lanzar();
  } else {
    $('#calculando').hidden = true;
    forzar = false;
    esperando.splice(0).forEach((r) => r());
  }
  dibujar();
};

function resultadoActual() {
  return new Promise((resolver) => {
    if (versionHecha === versionPedida && !fuenteSucia && S.res && !S.res.rapido && !ocupado) return resolver();
    esperando.push(resolver);
    if (S.res && S.res.rapido && versionHecha === versionPedida) { versionPedida++; rapidoPedido = false; }
    forzar = true;
    lanzar();
  });
}

// ---------- imagen ----------
function reconstruirLienzos() {
  for (const c of [cBase, cRGB, cAlfa]) { c.width = S.w; c.height = S.h; }
  xRGB.putImageData(new ImageData(S.rgb, S.w, S.h), 0, 0);
  actualizarRegion(0, 0, S.w, S.h);
}

function actualizarRegion(x0, y0, x1, y1) {
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  x1 = Math.min(S.w, Math.ceil(x1)); y1 = Math.min(S.h, Math.ceil(y1));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;
  const img = new ImageData(rw, rh), gris = new ImageData(rw, rh);
  const a = img.data, g = gris.data, rgb = S.rgb, alfa = S.alfa;
  for (let y = 0; y < rh; y++) {
    let i = (y0 + y) * S.w + x0, o = y * rw * 4;
    for (let x = 0; x < rw; x++, i++, o += 4) {
      const s = i * 4, v = alfa[i];
      a[o] = rgb[s]; a[o + 1] = rgb[s + 1]; a[o + 2] = rgb[s + 2]; a[o + 3] = v;
      g[o] = g[o + 1] = g[o + 2] = v; g[o + 3] = 255;
    }
  }
  xBase.putImageData(img, x0, y0);
  xAlfa.putImageData(gris, x0, y0);
  fuenteSucia = true;
  versionPedida++;
}

// Los píxeles transparentes pierden su color al pasar por el canvas; se les
// pone el color del vecino visible más cercano para que al reescalar no
// salgan bordes oscuros.
function extenderColores(rgb, alfa, w, h) {
  const N = w * h, cola = new Int32Array(N), listo = new Uint8Array(N);
  let ini = 0, fin = 0;
  for (let i = 0; i < N; i++) if (alfa[i] >= 64) { listo[i] = 1; cola[fin++] = i; }
  if (fin === 0 || fin === N) return;
  while (ini < fin) {
    const i = cola[ini++], x = i % w;
    const vecinos = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of vecinos) {
      if (j < 0 || j >= N || listo[j]) continue;
      listo[j] = 1;
      rgb[j * 4] = rgb[i * 4]; rgb[j * 4 + 1] = rgb[i * 4 + 1]; rgb[j * 4 + 2] = rgb[i * 4 + 2];
      cola[fin++] = j;
    }
  }
}

function establecerImagen(w, h, rgb, alfa) {
  S.w = w; S.h = h; S.rgb = rgb; S.alfa = alfa;
  reconstruirLienzos();
  $('#soltar').classList.add('oculto');
  $$('[data-necesita-imagen]').forEach((b) => b.classList.remove('apagado'));
  const transp = alfa.some((v) => v < 255);
  $('#infoImagen').textContent = `${w} × ${h} px · ${transp ? 'con transparencia' : 'sin transparencia'}`;
  actualizarInfoImpresion();
  dibujar();
  if (S.vista === 'resultado') pedirResultado();
}

async function leerPixeles(fuente, conversion = 'default') {
  const bmp = await createImageBitmap(fuente, { colorSpaceConversion: conversion, premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  return { w: c.width, h: c.height, d };
}

async function abrirArchivo(archivo) {
  if (!archivo || !archivo.type.startsWith('image/')) return;
  estado('Abriendo…');
  const { w, h, d } = await leerPixeles(archivo);
  const alfa = new Uint8Array(w * h);
  for (let i = 0; i < alfa.length; i++) alfa[i] = d[i * 4 + 3];
  extenderColores(d, alfa, w, h);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  S.deshacer = []; S.rehacer = [];
  S.nombre = archivo.name.replace(/\.[^.]+$/, '');
  $('#archivo').textContent = archivo.name;
  $('#nombre').value = S.nombre + ' DTF';
  $('#reporte').hidden = true;
  $$('.progreso').forEach((b) => { b.hidden = true; });
  S.zoom = 1; S.cx = 0.5; S.cy = 0.5;
  establecerImagen(w, h, d, alfa);
  estado('');
}

// ---------- historial ----------
function guardarHistorial(entrada) {
  S.deshacer.push(entrada);
  if (S.deshacer.length > 30) S.deshacer.shift();
  S.rehacer = [];
}

function aplicarHistorial(desde, hacia, adelante) {
  const e = desde.pop();
  if (!e) return;
  if (e.tipo === 'region') {
    const datos = adelante ? e.despues : e.antes;
    for (let y = 0; y < e.h; y++) S.alfa.set(datos.subarray(y * e.w, (y + 1) * e.w), (e.y + y) * S.w + e.x);
    actualizarRegion(e.x, e.y, e.x + e.w, e.y + e.h);
  } else if (e.tipo === 'alfa') {
    const actual = S.alfa; S.alfa = e.alfa; e.alfa = actual;
    actualizarRegion(0, 0, S.w, S.h);
  } else if (e.tipo === 'todo') {
    const actual = { w: S.w, h: S.h, rgb: S.rgb, alfa: S.alfa };
    establecerImagen(e.w, e.h, e.rgb, e.alfa);
    Object.assign(e, actual);
  }
  hacia.push(e);
  dibujar();
  if (S.vista === 'resultado') pedirResultado();
}
const deshacer = () => aplicarHistorial(S.deshacer, S.rehacer, false);
const rehacer = () => aplicarHistorial(S.rehacer, S.deshacer, true);

function recortarRegion(arr, x, y, w, h) {
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) out.set(arr.subarray((y + j) * S.w + x, (y + j) * S.w + x + w), j * w);
  return out;
}

// ---------- vista ----------
let dpr = window.devicePixelRatio || 1;
let raton = null; // posición del ratón en píxeles del lienzo
let patronCuadros = null;

function fuenteVista() {
  if (S.vista === 'resultado' && S.res) return cRes;
  return S.rgb ? cBase : null;
}

function transformar(fuente) {
  const W = lienzo.width, H = lienzo.height;
  const iw = fuente.width, ih = fuente.height;
  const ajuste = Math.min(W / iw, H / ih) * 0.94;
  const s = ajuste * S.zoom;
  return { s, x: W / 2 - S.cx * iw * s, y: H / 2 - S.cy * ih * s, iw, ih, ajuste };
}

let pendienteDibujo = false;
function dibujar() {
  if (pendienteDibujo) return;
  pendienteDibujo = true;
  requestAnimationFrame(() => { pendienteDibujo = false; dibujarYa(); });
}

function dibujarYa() {
  dpr = window.devicePixelRatio || 1;
  const W = Math.round(lienzo.clientWidth * dpr), H = Math.round(lienzo.clientHeight * dpr);
  if (lienzo.width !== W || lienzo.height !== H) { lienzo.width = W; lienzo.height = H; }
  ctx.fillStyle = '#0e0f10';
  ctx.fillRect(0, 0, W, H);
  const f = fuenteVista();
  if (!f) { $('#zoomTxt').textContent = '—'; return; }
  const t = transformar(f);
  const rw = t.iw * t.s, rh = t.ih * t.s;
  if (S.fondo === 'cuadros') {
    if (!patronCuadros) {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#cfcfcf'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
      patronCuadros = ctx.createPattern(c, 'repeat');
    }
    ctx.fillStyle = patronCuadros;
  } else {
    ctx.fillStyle = S.fondo;
  }
  ctx.fillRect(t.x, t.y, rw, rh);
  ctx.imageSmoothingEnabled = t.s < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f, t.x, t.y, rw, rh);
  $('#zoomTxt').textContent = Math.round(t.s * 100) + '%';

  const pincel = S.herr === 'borrar' || S.herr === 'restaurar';
  if (pincel && raton && S.vista === 'imagen' && !espacio) {
    const tb = transformar(cBase);
    const r = Math.max(1, S.pincel / 2 * tb.s);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.beginPath(); ctx.arc(raton.x, raton.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath(); ctx.arc(raton.x, raton.y, r + 1.5 * dpr, 0, Math.PI * 2); ctx.stroke();
  }
}

function zoomEn(nuevo, px, py) {
  const f = fuenteVista();
  if (!f) return;
  const t = transformar(f);
  const u = (px - t.x) / (t.iw * t.s), v = (py - t.y) / (t.ih * t.s);
  S.zoom = Math.min(80, Math.max(0.1, nuevo));
  const s2 = t.ajuste * S.zoom;
  S.cx = u - (px - lienzo.width / 2) / (t.iw * s2);
  S.cy = v - (py - lienzo.height / 2) / (t.ih * s2);
  dibujar();
}

function ponerVista(v) {
  S.vista = v;
  $$('#vista button').forEach((b) => b.classList.toggle('activo', b.dataset.v === v));
  if (v === 'resultado') pedirResultado();
  else $('#calculando').hidden = true;
  dibujar();
}

// ---------- pinceles ----------
let trazo = null, arrastre = null, espacio = false;

function aImagen(px, py) {
  const t = transformar(cBase);
  return { x: (px - t.x) / t.s, y: (py - t.y) / t.s };
}

function sellar(cx, cy) {
  const r = Math.max(0.5, S.pincel / 2), r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(S.w, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(S.h, Math.ceil(cy + r));
  if (x0 >= x1 || y0 >= y1) return;
  const val = S.herr === 'borrar' ? 0 : 255;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= r2) S.alfa[y * S.w + x] = val;
    }
  }
  trazo.x0 = Math.min(trazo.x0, x0); trazo.y0 = Math.min(trazo.y0, y0);
  trazo.x1 = Math.max(trazo.x1, x1); trazo.y1 = Math.max(trazo.y1, y1);
  actualizarRegion(x0, y0, x1, y1);
}

function sellarLinea(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const paso = Math.max(0.5, S.pincel / 6);
  const n = Math.max(1, Math.ceil(d / paso));
  for (let k = 1; k <= n; k++) sellar(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
}

function terminarTrazo() {
  if (!trazo) return;
  const { x0, y0, x1, y1, copia } = trazo;
  trazo = null;
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0, h = y1 - y0;
  const antes = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) antes.set(copia.subarray((y0 + j) * S.w + x0, (y0 + j) * S.w + x1), j * w);
  guardarHistorial({ tipo: 'region', x: x0, y: y0, w, h, antes, despues: recortarRegion(S.alfa, x0, y0, w, h) });
}

function varita(px, py) {
  const x = Math.floor(px), y = Math.floor(py);
  if (x < 0 || y < 0 || x >= S.w || y >= S.h) return;
  const W = S.w, N = W * S.h, i0 = y * W + x;
  if (S.alfa[i0] === 0) return;
  const rgb = S.rgb, alfa = S.alfa;
  const r0 = rgb[i0 * 4], g0 = rgb[i0 * 4 + 1], b0 = rgb[i0 * 4 + 2];
  const tol = S.tol * 2.55;
  const parecido = (i) => alfa[i] > 0 &&
    Math.abs(rgb[i * 4] - r0) <= tol && Math.abs(rgb[i * 4 + 1] - g0) <= tol && Math.abs(rgb[i * 4 + 2] - b0) <= tol;
  const copia = alfa.slice();
  let x0 = W, y0 = S.h, x1 = 0, y1 = 0;
  const marcar = (i) => {
    alfa[i] = 0;
    const xx = i % W, yy = (i / W) | 0;
    if (xx < x0) x0 = xx; if (xx >= x1) x1 = xx + 1;
    if (yy < y0) y0 = yy; if (yy >= y1) y1 = yy + 1;
  };
  if (S.contiguo) {
    const pila = new Int32Array(N), visto = new Uint8Array(N);
    let tope = 0;
    pila[tope++] = i0; visto[i0] = 1;
    while (tope) {
      const i = pila[--tope];
      marcar(i);
      const xx = i % W;
      const vec = [xx > 0 ? i - 1 : -1, xx < W - 1 ? i + 1 : -1, i - W, i + W];
      for (const j of vec) {
        if (j < 0 || j >= N || visto[j]) continue;
        visto[j] = 1;
        if (parecido(j)) pila[tope++] = j;
      }
    }
  } else {
    for (let i = 0; i < N; i++) if (parecido(i)) marcar(i);
  }
  if (x1 <= x0) return;
  const w = x1 - x0, h = y1 - y0;
  const antes = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) antes.set(copia.subarray((y0 + j) * W + x0, (y0 + j) * W + x1), j * w);
  guardarHistorial({ tipo: 'region', x: x0, y: y0, w, h, antes, despues: recortarRegion(alfa, x0, y0, w, h) });
  actualizarRegion(x0, y0, x1, y1);
  dibujar();
}

function ponerHerramienta(h) {
  S.herr = h;
  $$('#herramientas button').forEach((b) => b.classList.toggle('activo', b.dataset.h === h));
  if (h !== 'mover' && S.vista !== 'imagen') ponerVista('imagen');
  $('#filaTol').style.display = h === 'varita' ? '' : 'none';
  $('#contiguo').parentElement.style.display = h === 'varita' ? '' : 'none';
  actualizarCursor();
  dibujar();
}

function actualizarCursor() {
  let c = 'default';
  if (espacio || S.herr === 'mover' || S.vista === 'resultado') c = arrastre ? 'grabbing' : 'grab';
  else if (S.herr === 'varita') c = 'crosshair';
  else c = 'none';
  lienzo.style.cursor = c;
}

const pos = (e) => ({ x: e.offsetX * dpr, y: e.offsetY * dpr });

lienzo.addEventListener('pointerdown', (e) => {
  if (!S.rgb) { $('#entrada').click(); return; }
  lienzo.setPointerCapture(e.pointerId);
  const p = pos(e);
  const mover = espacio || e.button === 1 || S.herr === 'mover' || S.vista === 'resultado';
  if (mover) {
    arrastre = { ...p };
    actualizarCursor();
    return;
  }
  if (e.button !== 0) return;
  const q = aImagen(p.x, p.y);
  if (S.herr === 'varita') { varita(q.x, q.y); return; }
  trazo = { copia: S.alfa.slice(), x0: S.w, y0: S.h, x1: 0, y1: 0, ultimo: q };
  sellar(q.x, q.y);
  dibujar();
});

lienzo.addEventListener('pointermove', (e) => {
  const p = pos(e);
  raton = p;
  if (arrastre) {
    const f = fuenteVista();
    const t = transformar(f);
    S.cx -= (p.x - arrastre.x) / (t.iw * t.s);
    S.cy -= (p.y - arrastre.y) / (t.ih * t.s);
    arrastre = p;
  } else if (trazo) {
    const q = aImagen(p.x, p.y);
    sellarLinea(trazo.ultimo, q);
    trazo.ultimo = q;
  }
  dibujar();
});

const soltarPuntero = () => {
  if (arrastre) { arrastre = null; actualizarCursor(); }
  if (trazo) { terminarTrazo(); if (S.vista === 'resultado') pedirResultado(); }
};
lienzo.addEventListener('pointerup', soltarPuntero);
lienzo.addEventListener('pointercancel', soltarPuntero);
lienzo.addEventListener('pointerleave', () => { raton = null; dibujar(); });

lienzo.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!fuenteVista()) return;
  const p = pos(e);
  zoomEn(S.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
}, { passive: false });

window.addEventListener('resize', dibujar);

// ---------- teclado ----------
const escribiendo = (el) => el && (el.tagName === 'SELECT' ||
  (el.tagName === 'INPUT' && ['text', 'number'].includes(el.type)));

window.addEventListener('keydown', (e) => {
  if (escribiendo(document.activeElement)) return;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? rehacer() : deshacer(); return; }
  if (cmd) return;
  if (e.code === 'Space') { e.preventDefault(); if (!espacio) { espacio = true; actualizarCursor(); dibujar(); } return; }
  const k = e.key.toLowerCase();
  const centro = [lienzo.width / 2, lienzo.height / 2];
  if (k === 'b') ponerHerramienta('borrar');
  else if (k === 'r') ponerHerramienta('restaurar');
  else if (k === 'w') ponerHerramienta('varita');
  else if (k === 'm') ponerHerramienta('mover');
  else if (k === 'v') ponerVista(S.vista === 'imagen' ? 'resultado' : 'imagen');
  else if (k === '[') cambiarPincel(S.pincel / 1.2);
  else if (k === ']') cambiarPincel(S.pincel * 1.2 + 1);
  else if (k === '0') ajustar();
  else if (k === '1') unoAUno();
  else if (k === '+' || k === '=') zoomEn(S.zoom * 1.5, ...centro);
  else if (k === '-') zoomEn(S.zoom / 1.5, ...centro);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { espacio = false; actualizarCursor(); dibujar(); }
});

function cambiarPincel(v) {
  S.pincel = Math.round(Math.min(600, Math.max(1, v)));
  $('#pincel').value = S.pincel;
  $('#pincelV').textContent = S.pincel + ' px';
  dibujar();
}
function ajustar() { S.zoom = 1; S.cx = 0.5; S.cy = 0.5; dibujar(); }
function unoAUno() {
  const f = fuenteVista();
  if (!f) return;
  const t = transformar(f);
  zoomEn(1 / t.ajuste, lienzo.width / 2, lienzo.height / 2);
}

// ---------- IA (corre en el navegador, ver ia.js) ----------
const ia = new Worker('ia.js', { type: 'module' });
let pedidoIA = 0;
const pendientesIA = new Map();
ia.onmessage = (e) => {
  const { id, aviso, ok, error } = e.data;
  const p = pendientesIA.get(id);
  if (!p) return;
  if (aviso) { p.alAvisar?.(aviso); return; }
  pendientesIA.delete(id);
  if (error) p.fallo(new Error(error)); else p.listo(ok);
};
function pedirIA(tipo, datos, alAvisar, transferir = []) {
  const id = ++pedidoIA;
  return new Promise((listo, fallo) => {
    pendientesIA.set(id, { listo, fallo, alAvisar });
    ia.postMessage({ id, tipo, datos }, transferir);
  });
}
function avisoEnBarra(barra) {
  barra.hidden = false;
  const relleno = barra.querySelector('div'), texto = barra.querySelector('span');
  return ({ progreso, mensaje }) => {
    relleno.style.width = Math.round((progreso || 0) * 100) + '%';
    texto.textContent = mensaje || '';
  };
}

// La salida ×4 de la IA llevada al tamaño pedido. El color se achica
// con suavizado alto; la transparencia aparte (en gris), igual que en la Mac.
function aEscala(r, tw, th) {
  const rgba = new Uint8ClampedArray(r.w * r.h * 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgba[i] = r.rgb[j]; rgba[i + 1] = r.rgb[j + 1]; rgba[i + 2] = r.rgb[j + 2]; rgba[i + 3] = 255;
  }
  const leer = (datos, w, h) => {
    if (w === tw && h === th) return datos;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(datos, w, h), 0, 0);
    const d = new OffscreenCanvas(tw, th);
    const x = d.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, tw, th);
    return x.getImageData(0, 0, tw, th).data;
  };
  const d = leer(rgba, r.w, r.h);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  const alfa = new Uint8Array(tw * th).fill(255);
  if (S.alfa.some((v) => v < 255)) {
    const g = new Uint8ClampedArray(S.w * S.h * 4);
    for (let i = 0; i < S.alfa.length; i++) {
      g[i * 4] = g[i * 4 + 1] = g[i * 4 + 2] = S.alfa[i]; g[i * 4 + 3] = 255;
    }
    const ga = leer(g, S.w, S.h);
    for (let i = 0; i < alfa.length; i++) alfa[i] = ga[i * 4];
  }
  return { w: tw, h: th, d, alfa };
}

function escalaNecesaria() {
  const { anchoIn } = medidas();
  return (anchoIn * S.imp.dpi) / S.w;
}

let trabajandoIA = false;
async function mejorar(escala) {
  if (!S.rgb || trabajandoIA) return;
  if (escala === 'medida') escala = Math.min(4, escalaNecesaria());
  escala = Number(escala);
  if (!(escala > 1)) return;
  const sale = S.w * escala * S.h * escala;
  if (sale > 180e6) {
    alert(`Saldría de ${Math.round(S.w * escala)}×${Math.round(S.h * escala)} px: demasiado grande. Usa una escala menor.`);
    return;
  }
  // la IA siempre saca ×4 y después se achica a la escala pedida: ese ×4 tiene que caber
  if (S.w * 4 * S.h * 4 > 200e6) {
    alert(`La imagen es muy grande para mejorarla aquí (${S.w}×${S.h} px). Achícala o usa la que ya tienes.`);
    return;
  }
  if (sale > 70e6 && !confirm(`Va a salir de ${Math.round(S.w * escala)}×${Math.round(S.h * escala)} px. Puede tardar unos minutos. ¿Sigo?`)) return;
  const modelo = $('#modeloIA .activo').dataset.v;
  const barra = $('#progresoIA');
  trabajandoIA = true;
  bloquearIA(true);
  try {
    barra.hidden = false;
    const rgb = new Uint8Array(S.w * S.h * 3);
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
      rgb[j] = S.rgb[i]; rgb[j + 1] = S.rgb[i + 1]; rgb[j + 2] = S.rgb[i + 2];
    }
    const r = await pedirIA('reescalar', { w: S.w, h: S.h, rgb, modelo }, avisoEnBarra(barra), [rgb.buffer]);
    barra.querySelector('span').textContent = 'Ajustando a la medida…';
    const c = aEscala(r, Math.max(1, Math.round(S.w * escala)), Math.max(1, Math.round(S.h * escala)));
    barra.querySelector('div').style.width = '100%';
    barra.querySelector('span').textContent = `Listo en ${r.segundos} s`;
    const alfa = c.alfa;
    guardarHistorial({ tipo: 'todo', w: S.w, h: S.h, rgb: S.rgb, alfa: S.alfa });
    establecerImagen(c.w, c.h, c.d, alfa);
  } catch (err) {
    barra.querySelector('span').textContent = 'Error: ' + err.message;
  } finally {
    trabajandoIA = false;
    bloquearIA(false);
  }
}

async function quitarFondo(modelo) {
  if (!S.rgb || trabajandoIA) return;
  const barra = modelo === 'rapido' || modelo === 'calidad' ? $('#progresoFondo') : null;
  trabajandoIA = true;
  bloquearIA(true);
  try {
    barra.hidden = false;
    // el modelo trabaja a 1024×1024 (estirada, como en rembg)
    const c = new OffscreenCanvas(1024, 1024);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(cRGB, 0, 0, 1024, 1024);
    const rgba = x.getImageData(0, 0, 1024, 1024).data;
    const r = await pedirIA('quitarFondo', { rgba, modelo }, avisoEnBarra(barra), [rgba.buffer]);
    barra.querySelector('div').style.width = '100%';
    barra.querySelector('span').textContent = `Listo en ${r.segundos} s`;
    const gris = new Uint8ClampedArray(1024 * 1024 * 4);
    for (let i = 0; i < r.mascara.length; i++) {
      gris[i * 4] = gris[i * 4 + 1] = gris[i * 4 + 2] = r.mascara[i]; gris[i * 4 + 3] = 255;
    }
    const cg = new OffscreenCanvas(1024, 1024);
    cg.getContext('2d').putImageData(new ImageData(gris, 1024, 1024), 0, 0);
    const cm = new OffscreenCanvas(S.w, S.h);
    const xm = cm.getContext('2d', { willReadFrequently: true });
    xm.imageSmoothingQuality = 'high';
    xm.drawImage(cg, 0, 0, S.w, S.h);
    const m = xm.getImageData(0, 0, S.w, S.h).data;
    const nueva = new Uint8Array(S.w * S.h);
    for (let i = 0; i < nueva.length; i++) nueva[i] = Math.min(S.alfa[i], m[i * 4]);
    guardarHistorial({ tipo: 'alfa', alfa: S.alfa });
    S.alfa = nueva;
    actualizarRegion(0, 0, S.w, S.h);
    $('#infoImagen').textContent = `${S.w} × ${S.h} px · con transparencia`;
    dibujar();
    if (S.vista === 'resultado') pedirResultado();
  } catch (err) {
    barra.querySelector('span').textContent = 'Error: ' + err.message;
  } finally {
    trabajandoIA = false;
    bloquearIA(false);
  }
}

function bloquearIA(si) {
  $$('[data-escala], #fondoCalidad, #fondoRapido').forEach((b) => { b.disabled = si; });
  if (!si) actualizarInfoImpresion();
}

// ---------- panel ----------
function estado(t) { $('#estado').textContent = t; }

function seg(id, alCambiar) {
  $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
    ponerSeg(id, b.dataset.v);
    alCambiar(b.dataset.v);
  }));
}
function ponerSeg(id, v) {
  $$(`#${id} button`).forEach((b) => b.classList.toggle('activo', b.dataset.v === v));
}

const ETIQUETAS = {
  trama: (v) => `${redondo(v, 2)} mm · ${Math.round(25.4 / v)} LPI`,
  tamPunto: (v) => (v > 0 ? `+${v} más gordos` : v < 0 ? `${v} más finos` : 'normal'),
  angulo: (v) => `${v}°`,
  corte: (v) => `${v}`,
  solido: (v) => `${v}`,
  minPunto: (v) => (v > 0 ? `${v}%` : 'sin límite'),
  maxPunto: (v) => (v < 100 ? `${v}%` : 'nunca'),
  limpieza: (v) => (v > 0 ? `${v} px` : 'apagado'),
  alfaUmbral: (v) => `${Math.round(v / 255 * 100)}%`,
  respiracion: (v) => (v > 0 ? `${v}% · lo sólido queda al ${100 - v}%` : 'apagado'),
  saturacion: (v) => (v > 0 ? `+${v}%` : 'apagado'),
  contraste: (v) => (v > 0 ? `+${v}%` : 'apagado'),
};

function pintarEtiqueta(k) {
  const el = $(`#${k}V`);
  if (el) el.textContent = ETIQUETAS[k](S.p[k]);
}

function sincronizarPanel() {
  for (const k of Object.keys(ETIQUETAS)) {
    $(`#${k}`).value = S.p[k];
    pintarEtiqueta(k);
  }
  $('#invertir').checked = S.p.invertir;
  $('#tintaColor').value = S.p.tintaColor;
  ponerSeg('modo', S.p.modo);
  ponerSeg('estilo', S.p.estilo);
  ponerSeg('alfaModo', S.p.alfaModo);
  ponerSeg('tinta', S.p.tinta);
  $$('#formas button').forEach((b) => b.classList.toggle('activo', b.dataset.v === S.p.forma));
  const alfa = S.p.modo === 'alfa';
  $('#filaCorte').hidden = alfa;
  $('#filaSolido').hidden = alfa;
  $('#filaInvertir').hidden = alfa;
  $('#corteT').textContent = S.p.modo === 'negra' ? 'Quitar oscuros desde' : 'Quitar claros desde';
  $('#solidoT').textContent = S.p.modo === 'negra' ? 'Sólido desde (claros)' : 'Sólido desde (oscuros)';
  $('#filaEstilo').hidden = !DE_CELDA.has(S.p.forma);
  $('#filaUmbral').hidden = S.p.alfaModo !== 'umbral';
  $('#filaColor').hidden = S.p.tinta !== 'solida';
  $('#filaVivos').hidden = S.p.tinta === 'solida';
  $('#filaContraste').hidden = S.p.tinta === 'solida';
}

// Los ajustes se recuerdan entre una vez y otra (la imagen no: pesa demasiado)
const CLAVE_AJUSTES = 'dtf-ajustes-v1';
function guardarAjustes() {
  try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify({ p: S.p, imp: S.imp, fondo: S.fondo })); } catch (e) { /* sin almacenamiento */ }
}
function cargarAjustes() {
  try {
    const g = JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || 'null');
    if (!g) return;
    for (const k of Object.keys(S.p)) if (g.p && k in g.p && typeof g.p[k] === typeof S.p[k]) S.p[k] = g.p[k];
    for (const k of Object.keys(S.imp)) if (g.imp && k in g.imp && typeof g.imp[k] === typeof S.imp[k]) S.imp[k] = g.imp[k];
    if (typeof g.fondo === 'string') S.fondo = g.fondo;
  } catch (e) { /* ajustes dañados: se usan los de fábrica */ }
}

function cambiar(cambios, rapido = false) {
  Object.assign(S.p, cambios);
  sincronizarPanel();
  guardarAjustes();
  if (S.rgb) {
    if (S.vista !== 'resultado') ponerVista('resultado');
    else pedirResultado(rapido);
  }
}

for (const k of Object.keys(ETIQUETAS)) {
  $(`#${k}`).addEventListener('input', (e) => {
    S.p[k] = Number(e.target.value);
    pintarEtiqueta(k);
    cambiar({}, true);
  });
  // al soltar el control, la versión completa
  $(`#${k}`).addEventListener('change', (e) => {
    S.p[k] = Number(e.target.value);
    pintarEtiqueta(k);
    cambiar({});
  });
}
$('#invertir').addEventListener('change', (e) => cambiar({ invertir: e.target.checked }));
$('#tintaColor').addEventListener('input', (e) => cambiar({ tintaColor: e.target.value }));
seg('modo', (v) => cambiar({ modo: v, ...DEFECTOS_MODO[v], ...(v === 'alfa' ? { alfaModo: 'semitono' } : {}) }));
seg('estilo', (v) => cambiar({ estilo: v }));
seg('alfaModo', (v) => cambiar({ alfaModo: v }));
seg('tinta', (v) => cambiar({ tinta: v }));
seg('vista', ponerVista);
seg('modeloIA', () => {});

const PRESETS = {
  blanca: { p: { modo: 'blanca', ...DEFECTOS_MODO.blanca, tinta: 'original', alfaModo: 'umbral' }, fondo: '#ffffff' },
  negra: { p: { modo: 'negra', ...DEFECTOS_MODO.negra, tinta: 'original', alfaModo: 'umbral' }, fondo: '#111111' },
  bn: { p: { modo: 'blanca', ...DEFECTOS_MODO.blanca, tinta: 'solida', tintaColor: '#000000', alfaModo: 'umbral' }, fondo: '#ffffff' },
  bnNegra: { p: { modo: 'negra', ...DEFECTOS_MODO.negra, tinta: 'solida', tintaColor: '#ffffff', alfaModo: 'umbral' }, fondo: '#111111' },
  alfa: { p: { modo: 'alfa', alfaModo: 'semitono', tinta: 'original' }, fondo: 'cuadros' },
};
$$('#presets button').forEach((b) => b.addEventListener('click', () => {
  const pr = PRESETS[b.dataset.p];
  ponerFondo(pr.fondo);
  cambiar(pr.p);
}));

function ponerFondo(f) {
  S.fondo = f;
  guardarAjustes();
  $$('#fondos [data-f]').forEach((b) => b.classList.toggle('activo', b.dataset.f === f));
  $('#fondos .otro').classList.toggle('activo', !$(`#fondos [data-f="${f}"]`));
  dibujar();
}
$$('#fondos [data-f]').forEach((b) => b.addEventListener('click', () => ponerFondo(b.dataset.f)));
$('#fondoOtro').addEventListener('input', (e) => ponerFondo(e.target.value));

// tipos de semitono con su miniatura
const cajaFormas = $('#formas');
for (const [v, nombre] of FORMAS) {
  const b = document.createElement('button');
  b.dataset.v = v;
  b.title = nombre;
  b.innerHTML = `<canvas width="128" height="80"></canvas><span>${nombre}</span>`;
  b.addEventListener('click', () => cambiar({ forma: v }));
  cajaFormas.appendChild(b);
}
function pintarMuestras(m) {
  const botones = $$('#formas button');
  m.bufs.forEach((buf, k) => {
    const c = botones[k].querySelector('canvas');
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), m.w, m.h), 0, 0);
  });
}
motor.postMessage({
  tipo: 'muestras', formas: FORMAS.map((f) => f[0]),
  p: {
    modo: 'blanca', corte: 255, solido: 0, invertir: false, tamPunto: 0, estilo: 'detalle',
    alfaModo: 'umbral', alfaUmbral: 128, tinta: 'solida', tintaColor: [20, 20, 22],
    minPunto: 0, maxPunto: 1, limpieza: 0, celda: 16, angulo: 22.5,
  },
});

// herramientas
$$('#herramientas button').forEach((b) => b.addEventListener('click', () => ponerHerramienta(b.dataset.h)));
$('#pincel').addEventListener('input', (e) => cambiarPincel(Number(e.target.value)));
$('#tolerancia').addEventListener('input', (e) => { S.tol = Number(e.target.value); $('#toleranciaV').textContent = S.tol; });
$('#contiguo').addEventListener('change', (e) => { S.contiguo = e.target.checked; });
$('#deshacer').addEventListener('click', deshacer);
$('#rehacer').addEventListener('click', rehacer);
$('#fondoCalidad').addEventListener('click', () => quitarFondo('calidad'));
$('#fondoRapido').addEventListener('click', () => quitarFondo('rapido'));
$$('[data-escala]').forEach((b) => b.addEventListener('click', () => mejorar(b.dataset.escala)));

// zoom
$('#zMas').addEventListener('click', () => zoomEn(S.zoom * 1.5, lienzo.width / 2, lienzo.height / 2));
$('#zMenos').addEventListener('click', () => zoomEn(S.zoom / 1.5, lienzo.width / 2, lienzo.height / 2));
$('#zAjustar').addEventListener('click', ajustar);
$('#z100').addEventListener('click', unoAUno);

// impresión
function actualizarInfoImpresion() {
  if (!S.rgb) return;
  const { anchoIn, altoIn, pw, ph } = medidas();
  const ppi = S.w / anchoIn;
  const cm = (v) => redondo(v * 2.54, 1);
  let txt = `Sale de ${pw} × ${ph} px · ${redondo(anchoIn, 2)} × ${redondo(altoIn, 2)} in (${cm(anchoIn)} × ${cm(altoIn)} cm).`;
  const el = $('#infoImpresion');
  const falta = S.imp.dpi / ppi;
  if (falta > 1.02) {
    txt += ` La imagen da ${Math.round(ppi)} ppi a ese tamaño: se estiraría ×${redondo(falta, 1)}. Súbele la calidad en el paso 2.`;
    el.className = 'nota aviso';
  } else {
    txt += ` La imagen alcanza (${Math.round(ppi)} ppi).`;
    el.className = 'nota bien';
  }
  el.textContent = txt;
  const bm = $('#escalaMedida');
  if (falta <= 1.02) { bm.textContent = 'Ya alcanza'; bm.disabled = true; }
  else { bm.textContent = `A la medida ×${redondo(Math.min(4, falta), 1)}`; bm.disabled = trabajandoIA; }
}
for (const id of ['ancho', 'unidad', 'dpi']) {
  $(`#${id}`).addEventListener('input', (e) => {
    const v = e.target.value;
    if (id === 'unidad' && v !== S.imp.unidad) {
      S.imp.ancho = redondo(v === 'cm' ? S.imp.ancho * 2.54 : S.imp.ancho / 2.54, 2);
      $('#ancho').value = S.imp.ancho;
    }
    if (id === 'ancho') { const n = Number(v); if (!(n > 0)) return; S.imp.ancho = n; }
    else if (id === 'dpi') S.imp.dpi = Number(v);
    else S.imp.unidad = v;
    fuenteSucia = true;
    guardarAjustes();
    actualizarInfoImpresion();
    pintarEtiqueta('trama');
    if (S.vista === 'resultado') pedirResultado();
  });
}

// ---------- exportar ----------
// Revisa el PNG ya escrito como lo va a leer el RIP: lo vuelve a abrir,
// cuenta los píxeles con transparencia a medias y lee los DPI grabados.
async function revisarPNG(png) {
  const bytes = new Uint8Array(await png.arrayBuffer());
  let dpi = null;
  for (let o = 8; o + 8 <= bytes.length;) {
    const largo = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
    const tipo = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    if (tipo === 'pHYs' && bytes[o + 16] === 1) {
      const ppm = (bytes[o + 8] << 24 | bytes[o + 9] << 16 | bytes[o + 10] << 8 | bytes[o + 11]) >>> 0;
      dpi = Math.round(ppm * 0.0254);
    }
    if (tipo === 'IDAT' || tipo === 'IEND') break;
    o += 12 + largo;
  }
  const { w, h, d } = await leerPixeles(png, 'none');
  let semitransparentes = 0, conTinta = 0;
  for (let o = 3; o < d.length; o += 4) {
    if (d[o] === 255) conTinta++;
    else if (d[o]) semitransparentes++;
  }
  return { ancho: w, alto: h, dpi, semitransparentes, con_tinta: conTinta,
    pulgadas: dpi ? [w / dpi, h / dpi] : null };
}

$('#exportar').addEventListener('click', exportar);
async function exportar() {
  if (!S.rgb) return;
  const boton = $('#exportar'), rep = $('#reporte');
  const nombre = ($('#nombre').value.trim() || 'diseño dtf').replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'dtf';
  // Chrome tiene diálogo de "Guardar" de verdad; hay que abrirlo antes de
  // ponerse a trabajar (solo deja abrirlo justo después del clic).
  let destino = null;
  if (window.showSaveFilePicker) {
    try {
      destino = await showSaveFilePicker({
        suggestedName: nombre + '.png', id: 'dtf-guardar',
        types: [{ description: 'PNG para DTF', accept: { 'image/png': ['.png'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return; // canceló el diálogo
      destino = null; // no se pudo abrir: se baja como descarga
    }
  }
  boton.disabled = true;
  boton.textContent = 'Preparando…';
  try {
    await resultadoActual();
    let { w, h, datos } = S.res;
    if ($('#recortar').checked) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0, o = y * w * 4 + 3; x < w; x++, o += 4) {
          if (datos[o]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
        }
      }
      if (x1 < 0) throw new Error('No quedó nada de tinta con estos ajustes.');
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const rec = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) rec.set(datos.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
      datos = rec; w = cw; h = ch;
    }
    // Revisión antes de escribir: cada píxel es tinta entera o nada
    let malos = 0;
    for (let o = 3; o < datos.length; o += 4) if (datos[o] !== 0 && datos[o] !== 255) malos++;
    if (malos) throw new Error(`${malos} píxeles semitransparentes: no se guarda.`);
    boton.textContent = 'Guardando…';
    const png = await codificarPNG(w, h, datos, S.imp.dpi);
    const info = await revisarPNG(png);
    if (info.semitransparentes) throw new Error(`El PNG salió con ${info.semitransparentes} píxeles semitransparentes: no se guarda.`);
    let donde;
    if (destino) {
      const f = await destino.createWritable();
      await f.write(png);
      await f.close();
      donde = destino.name;
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(png);
      a.download = nombre + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      donde = `Descargas · ${nombre}.png`;
    }
    const cm = (v) => redondo(v * 2.54, 1);
    const pulg = info.pulgadas || [w / S.imp.dpi, h / S.imp.dpi];
    rep.innerHTML = `
      <div><span>Guardado como</span><span class="ruta" title="${escapar(donde)}">${escapar(donde)}</span></div>
      <div><span>Píxeles</span><span>${info.ancho} × ${info.alto}</span></div>
      <div><span>Medida</span><span>${redondo(pulg[0], 2)} × ${redondo(pulg[1], 2)} in · ${cm(pulg[0])} × ${cm(pulg[1])} cm</span></div>
      <div><span>DPI grabado</span><span>${info.dpi ?? '—'}</span></div>
      <div><span>Semitransparencias</span><span class="${info.semitransparentes === 0 ? 'bien' : 'mal'}">${info.semitransparentes === 0 ? '0 — limpio ✓' : info.semitransparentes}</span></div>
      <div><span>Con tinta</span><span>${redondo(info.con_tinta / (info.ancho * info.alto) * 100, 1)}%</span></div>`;
    rep.hidden = false;
  } catch (err) {
    rep.innerHTML = `<div><span class="mal">${escapar(err.message || String(err))}</span></div>`;
    rep.hidden = false;
  } finally {
    boton.disabled = false;
    boton.textContent = 'Guardar PNG para DTF…';
  }
}

// ---------- abrir ----------
$('#entrada').addEventListener('change', (e) => { abrirArchivo(e.target.files[0]); e.target.value = ''; });
const zonaSoltar = $('#soltar');
window.addEventListener('dragover', (e) => { e.preventDefault(); zonaSoltar.classList.add('encima'); });
window.addEventListener('dragleave', () => zonaSoltar.classList.remove('encima'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  zonaSoltar.classList.remove('encima');
  abrirArchivo(e.dataTransfer.files[0]);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) abrirArchivo(item.getAsFile());
});



// Pellizco en el trackpad (WebKit lo manda como gesto, no como rueda)
let zoomGesto = 1;
lienzo.addEventListener('gesturestart', (e) => { e.preventDefault(); zoomGesto = S.zoom; });
lienzo.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (!fuenteVista()) return;
  const r = lienzo.getBoundingClientRect();
  zoomEn(zoomGesto * e.scale, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
});

// arranque
cargarAjustes();
$('#ancho').value = S.imp.ancho;
$('#unidad').value = S.imp.unidad;
$('#dpi').value = String(S.imp.dpi);
ponerFondo(S.fondo);
$$('[data-necesita-imagen]').forEach((b) => b.classList.add('apagado'));
$('#pincelV').textContent = S.pincel + ' px';
$('#toleranciaV').textContent = S.tol;
ponerHerramienta('mover');
sincronizarPanel();
dibujar();

// Abrir con la app (clic derecho > Abrir con > DTF Semitonos, cuando está instalada)
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (p) => { if (p.files?.length) abrirArchivo(await p.files[0].getFile()); });
}
pedirIA('info').then((i) => {
  $('#motorIA').textContent = i.gpu ? 'IA: GPU' : 'IA: procesador (lento)';
  if (!i.f16) {
    $('#fondoCalidad').title = 'Esta computadora no tiene la GPU que hace falta para este modelo: usa "Rápido".';
  }
}).catch(() => {});
