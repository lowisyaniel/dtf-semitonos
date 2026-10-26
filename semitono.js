// Motor de semitonos. Corre en un Worker para no trabar la página.
//
// Entra la imagen ya al tamaño de impresión (RGB + transparencia) y sale un
// RGBA donde cada píxel es tinta (alfa 255) o nada (alfa 0). Nunca un punto
// intermedio: eso es lo que el DTF no aguanta.
//
// Cómo decide la tinta: cada píxel tiene una "cobertura" (0 = nada, 1 = sólido)
// sacada del tono y la transparencia. La trama reparte la celda en un orden de
// prioridad según la forma (punto, línea, rombo...). El píxel lleva tinta si su
// lugar en ese orden cae dentro de la cobertura. Las tablas de cuantiles hacen
// que la cantidad de tinta sea igual a la cobertura para cualquier forma.

'use strict';

// Borde del corazón visto desde su centro, por ángulo (curva polar clásica
// r = 2 - 2 sen t + sen t·√|cos t| / (sen t + 1.4)).
const BORDE_CORAZON = (() => {
  const pts = [];
  for (let k = 0; k < 6000; k++) {
    const t = k / 6000 * 2 * Math.PI, s = Math.sin(t), c = Math.cos(t);
    const r = 2 - 2 * s + s * Math.sqrt(Math.abs(c)) / (s + 1.4);
    pts.push([r * c, r * s]);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, n = 720;
  const tabla = new Float32Array(n);
  for (const [x, y] of pts) {
    const a = Math.atan2(y - cy, x - cx);
    const k = ((a + Math.PI) / (2 * Math.PI) * n | 0) % n;
    tabla[k] = Math.max(tabla[k], Math.hypot(x - cx, y - cy));
  }
  for (let k = 0; k < n; k++) if (!tabla[k]) tabla[k] = tabla[(k + n - 1) % n];
  return tabla;
})();

// x, y: posición dentro de la celda, de -1 a 1. U, V: posición en celdas
// (sirve para las formas que no se repiten por celda, como las ondas).
// Devuelve la prioridad: lo más bajo se entinta primero.
const FORMAS = {
  redondo: (x, y) => x * x + y * y,
  clasico: (x, y) => {
    const ax = Math.abs(x), ay = Math.abs(y);
    if (ax + ay <= 1) return x * x + y * y;
    return 2 - ((1 - ax) * (1 - ax) + (1 - ay) * (1 - ay));
  },
  cuadrado: (x, y) => Math.max(Math.abs(x), Math.abs(y)),
  rombo: (x, y) => Math.abs(x) + Math.abs(y),
  elipse: (x, y) => x * x + 2.6 * y * y,
  cruz: (x, y) => {
    const ax = Math.abs(x), ay = Math.abs(y);
    return Math.max(Math.min(ax, ay) * 3, Math.max(ax, ay));
  },
  cuadricula: (x, y) => Math.min(Math.abs(x), Math.abs(y)),
  triangulo: (x, y) => Math.max(y, 0.866 * x - 0.5 * y, -0.866 * x - 0.5 * y),
  estrella: (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const a = Math.atan2(y, x);
    return r * (1 - 0.45 * Math.cos(5 * a + 1.5708));
  },
  // distancia al centro dividida entre la distancia al borde en esa dirección:
  // así cada nivel es el mismo corazón más grande o más chiquito
  corazon: (x, y) => {
    const a = Math.atan2(-y, x);
    const k = ((a + Math.PI) / (2 * Math.PI) * BORDE_CORAZON.length) | 0;
    return Math.sqrt(x * x + y * y) / BORDE_CORAZON[k % BORDE_CORAZON.length];
  },
  lineas: (x, y) => Math.abs(y),
  ondas: (x, y, U, V) => {
    const w = V + 0.28 * Math.sin(U * 2.0944); // una ola cada 3 celdas
    return Math.abs((w - Math.floor(w)) * 2 - 1);
  },
  zigzag: (x, y, U, V) => {
    const f = U / 1.5 - Math.floor(U / 1.5);
    const w = V + 0.35 * (Math.abs(f * 2 - 1) * 2 - 1);
    return Math.abs((w - Math.floor(w)) * 2 - 1);
  },
};

// Las que forman puntos separados: pueden ir en modo "pop art" (un punto
// entero por celda, con el tono medido en el centro).
const DE_CELDA = new Set(['redondo', 'clasico', 'cuadrado', 'rombo', 'elipse',
  'cruz', 'triangulo', 'estrella', 'corazon']);

const CUANTILES = {};
const PASOS = 1024;

function tablaCuantiles(nombre) {
  if (CUANTILES[nombre]) return CUANTILES[nombre];
  const f = FORMAS[nombre];
  const n = 256, muestras = new Float32Array(n * n);
  const global = nombre === 'ondas' || nombre === 'zigzag';
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let U, V, x, y;
      if (global) {
        U = (i + 0.5) / n * 6; V = (j + 0.5) / n * 6;
        x = (U - Math.floor(U)) * 2 - 1; y = (V - Math.floor(V)) * 2 - 1;
      } else {
        x = (i + 0.5) / n * 2 - 1; y = (j + 0.5) / n * 2 - 1; U = x; V = y;
      }
      muestras[k++] = f(x, y, U, V);
    }
  }
  muestras.sort();
  const q = new Float32Array(PASOS + 1);
  for (let s = 0; s <= PASOS; s++) {
    q[s] = muestras[Math.min(muestras.length - 1, Math.floor(s / PASOS * muestras.length))];
  }
  q[PASOS] = Infinity;
  return (CUANTILES[nombre] = q);
}

let fuente = null; // {w, h, datos: Uint8ClampedArray RGBA, A = transparencia real}

self.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'fuente') {
    fuente = { w: m.w, h: m.h, datos: new Uint8ClampedArray(m.buf) };
    return;
  }
  if (m.tipo === 'muestras') {
    // degradado de claro a oscuro para ver cada forma en todos sus tamaños
    const w = 128, h = 80, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, v = 255 - Math.round((x + 0.5) / w * 255);
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
    const src = { w, h, datos: d };
    const res = m.formas.map((forma) => procesar(src, { ...m.p, forma }).salida);
    self.postMessage({ tipo: 'muestras', w, h, bufs: res.map((r) => r.buffer) }, res.map((r) => r.buffer));
    return;
  }
  if (m.tipo === 'procesar') {
    if (!fuente) return;
    const t0 = performance.now();
    // Vista rápida mientras se arrastra un control: media resolución, misma trama
    let src = fuente, p = m.p;
    if (m.rapido) {
      if (!fuente.mitad) fuente.mitad = reducir(fuente);
      src = fuente.mitad;
      p = { ...p, celda: p.celda / 2, limpieza: Math.round(p.limpieza / 4) };
    }
    const r = procesar(src, p);
    r.info.ms = Math.round(performance.now() - t0);
    self.postMessage({ id: m.id, rapido: !!m.rapido, w: src.w, h: src.h, buf: r.salida.buffer, info: r.info },
      [r.salida.buffer]);
  }
};

function reducir(src) {
  const w = Math.max(1, src.w >> 1), h = Math.max(1, src.h >> 1), d = src.datos;
  const out = new Uint8ClampedArray(w * h * 4), W = src.w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((2 * y) * W + 2 * x) * 4, b = a + 4, c = a + W * 4, e = c + 4, o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (d[a + k] + d[b + k] + d[c + k] + d[e + k] + 2) >> 2;
    }
  }
  return { w, h, datos: out };
}

function procesar(src, p) {
  const { w, h, datos } = src;
  const N = w * h;

  const etapas = [performance.now()];
  // ---- 1. Cobertura por píxel: tono + transparencia ----
  const cob = new Float32Array(N);
  const dentro = new Uint8Array(N); // el píxel es parte del diseño (pasa el umbral de transparencia)
  // Curva de tono precalculada: luminancia (en cuartos de nivel) → cobertura
  const expo = Math.pow(2, -p.tamPunto / 50); // tamaño del punto: >0 = puntos más gordos
  const rango = p.solido - p.corte;
  const curva = new Float32Array(1024);
  for (let k = 0; k < 1024; k++) {
    const L = k / 4;
    let t = rango === 0 ? (L >= p.corte ? 1 : 0) : (L - p.corte) / rango;
    if (p.invertir) t = 1 - t;
    curva[k] = t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, expo);
  }
  const umbral = p.alfaUmbral;
  const soloAlfa = p.modo === 'alfa';
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const a = datos[o + 3];
    let t;
    if (soloAlfa) {
      t = 1;
    } else {
      t = curva[(0.8504 * datos[o] + 2.8608 * datos[o + 1] + 0.2888 * datos[o + 2]) | 0];
    }
    if (p.alfaModo === 'semitono') {
      dentro[i] = a > 0 ? 1 : 0;
      t *= a / 255;
    } else {
      dentro[i] = a >= umbral ? 1 : 0;
      if (!dentro[i]) t = 0;
    }
    cob[i] = t;
  }

  // Punto mínimo / máximo: lo que no llega al mínimo desaparece (esos puntitos
  // se despegan del film), lo que pasa del máximo se vuelve sólido.
  const minP = p.minPunto, maxP = p.maxPunto;
  // Respiración: los sólidos dejan de ser sólidos y se llenan de huequitos
  // para que la prenda respire. Solo se comprime la parte alta de la
  // cobertura (de `codo` para arriba); lo claro, los medios tonos bajos y lo
  // que se quitó quedan exactamente igual.
  const resp = Math.min(0.5, Math.max(0, p.respiracion || 0));
  const techo = 1 - resp, codo = Math.max(0, 1 - 2 * resp);
  const respirar = (t) => (resp > 0 && t > codo ? codo + (t - codo) * (techo - codo) / (1 - codo) : t);
  const recortar = (t) => respirar(t < minP ? 0 : t > maxP ? 1 : t);

  etapas.push(performance.now());
  // ---- 2. Tinta sí / no ----
  const tinta = new Uint8Array(N);
  const forma = p.forma;
  if (forma === 'ninguno' && resp > 0) {
    // Sin trama pero respirando: la imagen va sólida y se perfora con
    // huequitos redondos (la trama clásica pasado el 50 % deja huecos redondos)
    for (let i = 0; i < N; i++) cob[i] = dentro[i] && cob[i] >= 0.5 ? 1 : 0;
    tramaPara('clasico')(cob, dentro, tinta, w, h, { ...p, forma: 'clasico', estilo: 'detalle' }, recortar);
  } else if (forma === 'ninguno') {
    for (let i = 0; i < N; i++) tinta[i] = dentro[i] && cob[i] >= 0.5 ? 1 : 0;
  } else if (forma === 'grano') {
    grano(cob, dentro, tinta, w, h, Math.max(1, Math.round(p.celda / 4)), recortar);
  } else if (forma === 'ruido') {
    ruido(cob, dentro, tinta, w, h, Math.max(1, Math.round(p.celda / 4)), recortar);
  } else if (forma === 'anillos') {
    const cx = w / 2, cy = h / 2, c = p.celda;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const t = recortar(cob[i]);
        if (!dentro[i] || t <= 0) continue;
        if (t >= 1) { tinta[i] = 1; continue; }
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / c;
        const pr = Math.abs((r - Math.floor(r)) * 2 - 1);
        if (pr < t) tinta[i] = 1; // prioridad uniforme: la cobertura es directa
      }
    }
  } else {
    tramaPara(forma)(cob, dentro, tinta, w, h, p, recortar);
  }

  etapas.push(performance.now());
  // ---- 3. Limpieza: motas sueltas y huequitos ----
  let motas = 0, huecos = 0;
  if (p.limpieza > 0) {
    motas = quitarIslas(tinta, w, h, 1, p.limpieza, dentro);
    huecos = quitarIslas(tinta, w, h, 0, p.limpieza, dentro);
  }

  etapas.push(performance.now());
  // ---- 4. Salida: color donde hay tinta, nada donde no ----
  const salida = new Uint8ClampedArray(N * 4);
  const solida = p.tinta === 'solida';
  const [tr, tg, tb] = p.tintaColor;
  let conTinta = 0;
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    if (!tinta[i]) continue;
    conTinta++;
    if (solida) { salida[o] = tr; salida[o + 1] = tg; salida[o + 2] = tb; }
    else { salida[o] = datos[o]; salida[o + 1] = datos[o + 1]; salida[o + 2] = datos[o + 2]; }
    salida[o + 3] = 255;
  }

  etapas.push(performance.now());
  const tiempos = etapas.slice(1).map((t, k) => Math.round(t - etapas[k]));
  return { salida, info: { conTinta, total: N, motas, huecos, tiempos } };
}

// Una copia de `trama` por forma: si todas las formas pasan por la misma
// función, el navegador deja de optimizar la llamada a la forma y todo va
// 3-4 veces más lento.
const copias = {};
function tramaPara(forma) {
  if (!copias[forma]) {
    copias[forma] = new Function('FORMAS', 'tablaCuantiles', 'PASOS', 'DE_CELDA',
      'return ' + trama.toString())(FORMAS, tablaCuantiles, PASOS, DE_CELDA);
  }
  return copias[forma];
}

function trama(cob, dentro, tinta, w, h, p, recortar) {
  const f = FORMAS[p.forma];
  const Q = tablaCuantiles(p.forma);
  const c = p.celda;
  const ang = p.angulo * Math.PI / 180;
  const co = Math.cos(ang), si = Math.sin(ang);
  const dUx = co / c, dVx = -si / c;
  const pop = p.estilo === 'pop' && DE_CELDA.has(p.forma);

  // Para el modo pop: tono promedio en bloques pequeños, leído en el centro de cada celda
  let mapa = null, fm = 1, mw = 0, mh = 0;
  if (pop) {
    fm = Math.max(1, Math.round(c / 2));
    mw = Math.ceil(w / fm); mh = Math.ceil(h / fm);
    mapa = new Float32Array(mw * mh);
    const cuenta = new Float32Array(mw * mh);
    for (let y = 0; y < h; y++) {
      const fila = ((y / fm) | 0) * mw;
      for (let x = 0, i = y * w; x < w; x++, i++) {
        const k = fila + ((x / fm) | 0);
        mapa[k] += cob[i]; cuenta[k]++;
      }
    }
    for (let k = 0; k < mapa.length; k++) mapa[k] /= cuenta[k];
  }
  const leer = (X, Y) => {
    // bilineal sobre el mapa
    let gx = X / fm - 0.5, gy = Y / fm - 0.5;
    if (gx < 0) gx = 0; if (gy < 0) gy = 0;
    if (gx > mw - 1) gx = mw - 1; if (gy > mh - 1) gy = mh - 1;
    const x0 = gx | 0, y0 = gy | 0;
    const x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const a = mapa[y0 * mw + x0], b = mapa[y0 * mw + x1];
    const cc = mapa[y1 * mw + x0], d = mapa[y1 * mw + x1];
    return (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
  };

  for (let y = 0; y < h; y++) {
    const Y = y + 0.5;
    let U = (0.5 * co + Y * si) / c;
    let V = (-0.5 * si + Y * co) / c;
    for (let x = 0, i = y * w; x < w; x++, i++, U += dUx, V += dVx) {
      if (!dentro[i]) continue;
      let t;
      if (pop) {
        // centro de la celda, de vuelta a coordenadas de la imagen
        const Uc = (Math.floor(U) + 0.5) * c, Vc = (Math.floor(V) + 0.5) * c;
        t = leer(Uc * co - Vc * si, Uc * si + Vc * co);
      } else {
        t = cob[i];
      }
      t = recortar(t);
      if (t <= 0) continue;
      if (t >= 1) { tinta[i] = 1; continue; }
      const fu = U - Math.floor(U), fv = V - Math.floor(V);
      const pr = f(fu * 2 - 1, fv * 2 - 1, U, V);
      const q = t * PASOS, k = q | 0;
      const lim = Q[k] + (Q[k + 1] - Q[k]) * (q - k);
      if (pr < lim) tinta[i] = 1;
    }
  }
}

// Grano fino por difusión de error (Floyd–Steinberg en serpentina) sobre
// bloques de `g` píxeles: da el look de "grano" o "estocástico".
function grano(cob, dentro, tinta, w, h, g, recortar) {
  const gw = Math.ceil(w / g), gh = Math.ceil(h / g);
  const v = new Float32Array(gw * gh), n = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const fila = ((y / g) | 0) * gw;
    for (let x = 0, i = y * w; x < w; x++, i++) { const k = fila + ((x / g) | 0); v[k] += cob[i]; n[k]++; }
  }
  for (let k = 0; k < v.length; k++) v[k] = recortar(v[k] / n[k]);
  const on = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const der = (y & 1) === 0;
    for (let s = 0; s < gw; s++) {
      const x = der ? s : gw - 1 - s, k = y * gw + x;
      const viejo = v[k], nuevo = viejo >= 0.5 ? 1 : 0;
      on[k] = nuevo;
      const err = viejo - nuevo, d = der ? 1 : -1;
      if (x + d >= 0 && x + d < gw) v[k + d] += err * 7 / 16;
      if (y + 1 < gh) {
        if (x - d >= 0 && x - d < gw) v[k + gw - d] += err * 3 / 16;
        v[k + gw] += err * 5 / 16;
        if (x + d >= 0 && x + d < gw) v[k + gw + d] += err * 1 / 16;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const fila = ((y / g) | 0) * gw;
    for (let x = 0, i = y * w; x < w; x++, i++) if (dentro[i] && on[fila + ((x / g) | 0)]) tinta[i] = 1;
  }
}

// Ruido "grunge": umbral contra ruido aleatorio fijo (sale igual cada vez).
function ruido(cob, dentro, tinta, w, h, g, recortar) {
  for (let y = 0; y < h; y++) {
    const by = (y / g) | 0;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      if (!dentro[i]) continue;
      const t = recortar(cob[i]);
      if (t <= 0) continue;
      const bx = (x / g) | 0;
      let s = Math.imul(bx, 374761393) + Math.imul(by, 668265263);
      s = Math.imul(s ^ (s >>> 13), 1274126177);
      s ^= s >>> 16;
      if (t > (s >>> 0) / 4294967296) tinta[i] = 1;
    }
  }
}

// Quita islas pequeñas: si valor=1, motas de tinta sueltas (se despegan);
// si valor=0, huequitos sin tinta dentro de zonas llenas (se tapan).
// Tinta cuenta conectada en 8 direcciones, huecos en 4 (la pareja correcta
// para que no se crucen). Devuelve cuántas islas cambió.
function quitarIslas(tinta, w, h, valor, maximo, dentro) {
  const N = w * h;
  const visto = new Uint8Array(N);
  const pila = new Int32Array(N);
  const miembros = new Int32Array(maximo + 1);
  const ocho = valor === 1, huecos = valor === 0;
  let cambiadas = 0;
  for (let s = 0; s < N; s++) {
    if (visto[s] || tinta[s] !== valor) continue;
    if (huecos && !dentro[s]) continue; // fuera del diseño no se tapa nada
    let tope = 0, cuantos = 0, borde = false;
    pila[tope++] = s; visto[s] = 1;
    while (tope > 0) {
      const i = pila[--tope];
      if (cuantos <= maximo) miembros[cuantos] = i;
      cuantos++;
      const y = (i / w) | 0, x = i - y * w;
      const l = x > 0, r = x < w - 1, u = y > 0, d = y < h - 1;
      if (!(l && r && u && d)) borde = true;
      // vecinos escritos a mano: es el lazo más caliente de todo el motor
      let j;
      if (l) { j = i - 1; if (!visto[j] && tinta[j] === valor) { if (huecos && !dentro[j]) borde = true; else { visto[j] = 1; pila[tope++] = j; } } }
      if (r) { j = i + 1; if (!visto[j] && tinta[j] === valor) { if (huecos && !dentro[j]) borde = true; else { visto[j] = 1; pila[tope++] = j; } } }
      if (u) { j = i - w; if (!visto[j] && tinta[j] === valor) { if (huecos && !dentro[j]) borde = true; else { visto[j] = 1; pila[tope++] = j; } } }
      if (d) { j = i + w; if (!visto[j] && tinta[j] === valor) { if (huecos && !dentro[j]) borde = true; else { visto[j] = 1; pila[tope++] = j; } } }
      if (ocho) {
        if (u && l) { j = i - w - 1; if (!visto[j] && tinta[j] === 1) { visto[j] = 1; pila[tope++] = j; } }
        if (u && r) { j = i - w + 1; if (!visto[j] && tinta[j] === 1) { visto[j] = 1; pila[tope++] = j; } }
        if (d && l) { j = i + w - 1; if (!visto[j] && tinta[j] === 1) { visto[j] = 1; pila[tope++] = j; } }
        if (d && r) { j = i + w + 1; if (!visto[j] && tinta[j] === 1) { visto[j] = 1; pila[tope++] = j; } }
      }
    }
    // un hueco que toca el borde o sale del diseño no es un huequito, es el afuera
    if (cuantos <= maximo && !(huecos && borde)) {
      for (let k = 0; k < cuantos; k++) tinta[miembros[k]] = 1 - valor;
      cambiadas++;
    }
  }
  return cambiadas;
}
