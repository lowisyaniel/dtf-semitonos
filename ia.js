// La IA corriendo dentro de Chrome (Worker): reescalar con Real-ESRGAN y
// quitar fondo con BiRefNet / ISNet. Es lo mismo que hacía ia.py en la Mac,
// pero con onnxruntime-web: en la GPU (WebGPU) si la hay, si no en el procesador.
//
// Los modelos se bajan la primera vez y se quedan guardados en el navegador
// (Cache Storage); la segunda vez abren sin internet.
import * as ort from './ort/ort.webgpu.bundle.min.mjs';

ort.env.logLevel = 'error'; // sus avisos normales llenan la consola
ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const CACHE = 'dtf-modelos-v1';
// Los archivos grandes van en partes de <100 MB (los hostings gratis no aceptan más por archivo)
const MODELOS = {
  ilustracion: { archivo: 'esrgan-ilustracion.onnx', partes: 0, mb: 18 },
  foto: { archivo: 'esrgan-foto.onnx', partes: 0, mb: 67 },
  // en GPU con fp16 se usan estos: 1.4–2 veces más rápidos, diferencia <1/255 de media
  ilustracion16: { archivo: 'esrgan-ilustracion-fp16.onnx', partes: 0, mb: 9, soloGPU: true },
  foto16: { archivo: 'esrgan-foto-fp16.onnx', partes: 0, mb: 34, soloGPU: true },
  rapido: { archivo: 'isnet.onnx', partes: 2, mb: 179 },
  // fp16: la mitad de peso; solo corre en la GPU
  calidad: { archivo: 'birefnet-fp16.onnx', partes: 5, mb: 490, soloGPU: true },
};

let gpu = null; // null = sin revisar; false = no hay
async function hayGPU() {
  if (gpu !== null) return gpu;
  gpu = false;
  try {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (a) {
      // Chrome da por defecto límites bajos; se pide el dispositivo con lo que
      // la GPU de verdad aguanta. (En la Mac igual son 10 buffers por shader:
      // por eso BiRefNet va con sus Concat partidos, ver herramientas/partir_concat.py.)
      const L = a.limits, limites = {};
      for (const k of ['maxStorageBuffersPerShaderStage', 'maxBufferSize', 'maxStorageBufferBindingSize',
        'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX',
        'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension']) {
        if (k in L) limites[k] = L[k];
      }
      const extras = ['shader-f16', 'subgroups'].filter((f) => a.features.has(f));
      ort.env.webgpu.device = await a.requestDevice({ requiredFeatures: extras, requiredLimits: limites });
      gpu = { f16: a.features.has('shader-f16'), buffers: L.maxStorageBuffersPerShaderStage };
    }
  } catch (e) { /* sin WebGPU */ }
  return gpu;
}

async function bajar(url, cache, alAvanzar) {
  const guardado = await cache.match(url);
  if (guardado) return new Uint8Array(await guardado.arrayBuffer());
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo bajar ${url.split('/').pop()} (${r.status})`);
  const total = Number(r.headers.get('Content-Length')) || 0;
  const lector = r.body.getReader();
  const trozos = [];
  let n = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    trozos.push(value);
    n += value.length;
    alAvanzar(n, total);
  }
  const datos = new Uint8Array(n);
  let o = 0;
  for (const t of trozos) { datos.set(t, o); o += t.length; }
  try { await cache.put(url, new Response(datos)); } catch (e) { /* sin espacio: se baja otra vez la próxima */ }
  return datos;
}

const sesiones = {};
async function sesion(id, aviso) {
  if (sesiones[id]) return sesiones[id];
  const m = MODELOS[id];
  const g = await hayGPU();
  if (m.soloGPU && !(g && g.f16)) {
    throw new Error('Esta computadora no tiene la GPU que necesita "Quitar fondo (IA)". Usa "Rápido".');
  }
  const cache = await caches.open(CACHE);
  const urls = m.partes
    ? Array.from({ length: m.partes }, (_, i) => new URL(`./modelos/${m.archivo}.parte${i}`, import.meta.url).href)
    : [new URL(`./modelos/${m.archivo}`, import.meta.url).href];
  const nuevo = !(await Promise.all(urls.map((u) => cache.match(u)))).every(Boolean);
  const piezas = [];
  let antes = 0;
  for (const u of urls) {
    const p = await bajar(u, cache, (n) => {
      const mb = (antes + n) / 1048576;
      aviso(Math.min(0.95, mb / m.mb) * 0.5, `Bajando el modelo (solo la primera vez): ${Math.round(mb)} de ${m.mb} MB`);
    });
    antes += p.length;
    piezas.push(p);
  }
  let modelo = piezas[0];
  if (piezas.length > 1) {
    modelo = new Uint8Array(antes);
    let o = 0;
    for (const p of piezas) { modelo.set(p, o); o += p.length; }
  }
  piezas.length = 0;
  aviso(nuevo ? 0.5 : 0.1, 'Preparando el modelo');
  const proveedores = g ? ['webgpu', 'wasm'] : ['wasm'];
  sesiones[id] = await ort.InferenceSession.create(modelo, {
    executionProviders: proveedores,
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  return sesiones[id];
}

// ---------- reescalar ----------
// Por pedazos (con margen para que no se vean costuras). Todos del mismo
// tamaño para que la GPU no recompile en cada uno: en los bordes el pedazo
// se corre hacia adentro en vez de rellenar, así el borde de la imagen sale
// igual que si la IA viera la imagen entera.
const PEDAZO = 256, MARGEN = 16, LADO = PEDAZO + 2 * MARGEN;

async function reescalar({ w, h, rgb, modelo }, aviso) {
  const s = await sesion((await hayGPU())?.f16 ? modelo + '16' : modelo, aviso);
  const f = 4;
  const TW = Math.min(LADO, w), TH = Math.min(LADO, h);
  const salida = new Uint8Array(w * f * h * f * 3);
  const entrada = new Float32Array(3 * TW * TH);
  const plano = TW * TH;
  const ys = [], xs = [];
  for (let y = 0; y < h; y += PEDAZO) ys.push(y);
  for (let x = 0; x < w; x += PEDAZO) xs.push(x);
  const total = ys.length * xs.length;
  let hechos = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      const ya = Math.min(Math.max(0, y0 - MARGEN), h - TH);
      const xa = Math.min(Math.max(0, x0 - MARGEN), w - TW);
      for (let j = 0; j < TH; j++) {
        let o = ((ya + j) * w + xa) * 3;
        for (let i = 0, d = j * TW; i < TW; i++, d++, o += 3) {
          entrada[d] = rgb[o] / 255;
          entrada[plano + d] = rgb[o + 1] / 255;
          entrada[2 * plano + d] = rgb[o + 2] / 255;
        }
      }
      const r = await s.run({ entrada: new ort.Tensor('float32', entrada, [1, 3, TH, TW]) });
      const o4 = await r.salida.getData();
      r.salida.dispose?.();
      const W4 = TW * f, p4 = W4 * TH * f;
      const y1 = Math.min(y0 + PEDAZO, h), x1 = Math.min(x0 + PEDAZO, w);
      for (let j = 0; j < (y1 - y0) * f; j++) {
        const fila = ((y0 - ya) * f + j) * W4 + (x0 - xa) * f;
        let d = ((y0 * f + j) * w * f + x0 * f) * 3;
        for (let i = 0; i < (x1 - x0) * f; i++, d += 3) {
          const q = fila + i;
          salida[d] = Math.round(Math.min(1, Math.max(0, o4[q])) * 255);
          salida[d + 1] = Math.round(Math.min(1, Math.max(0, o4[p4 + q])) * 255);
          salida[d + 2] = Math.round(Math.min(1, Math.max(0, o4[2 * p4 + q])) * 255);
        }
      }
      hechos++;
      aviso(0.5 + 0.5 * hechos / total, `Mejorando pedazo ${hechos} de ${total}`);
    }
  }
  return { w: w * f, h: h * f, rgb: salida };
}

// ---------- quitar fondo ----------
// Igual que rembg: la imagen a 1024×1024, dividida por su valor más alto,
// normalizada; la máscara estirada entre su mínimo y su máximo.
async function quitarFondo({ rgba, modelo }, aviso) {
  const s = await sesion(modelo, aviso);
  aviso(0.6, 'Buscando el sujeto');
  const N = 1024, plano = N * N;
  let max = 1e-6;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > max) max = rgba[i];
    if (rgba[i + 1] > max) max = rgba[i + 1];
    if (rgba[i + 2] > max) max = rgba[i + 2];
  }
  const [media, desv] = modelo !== 'rapido'
    ? [[0.485, 0.456, 0.406], [0.229, 0.224, 0.225]]
    : [[0.5, 0.5, 0.5], [1, 1, 1]];
  const x = new Float32Array(3 * plano);
  for (let i = 0; i < plano; i++) {
    for (let c = 0; c < 3; c++) x[c * plano + i] = (rgba[i * 4 + c] / max - media[c]) / desv[c];
  }
  const nombre = s.inputNames[0];
  const r = await s.run({ [nombre]: new ort.Tensor('float32', x, [1, 3, N, N]) });
  const t = r[s.outputNames[0]];
  const p = await t.getData();
  for (const k of s.outputNames) r[k].dispose?.();
  const pred = new Float32Array(plano);
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < plano; i++) {
    const v = modelo !== 'rapido' ? 1 / (1 + Math.exp(-p[i])) : p[i];
    pred[i] = v;
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  const mascara = new Uint8Array(plano);
  const rango = ma - mi || 1;
  for (let i = 0; i < plano; i++) mascara[i] = Math.floor((pred[i] - mi) / rango * 255);
  return { mascara };
}

self.onmessage = async (e) => {
  const { id, tipo, datos } = e.data;
  const aviso = (progreso, mensaje) => self.postMessage({ id, aviso: { progreso, mensaje } });
  try {
    if (tipo === 'info') {
      const g = await hayGPU();
      self.postMessage({ id, ok: { gpu: !!g, f16: !!(g && g.f16), hilos: ort.env.wasm.numThreads } });
      return;
    }
    const inicio = performance.now();
    const r = tipo === 'reescalar' ? await reescalar(datos, aviso) : await quitarFondo(datos, aviso);
    r.segundos = Math.round((performance.now() - inicio) / 100) / 10;
    self.postMessage({ id, ok: r }, [(r.rgb || r.mascara).buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
