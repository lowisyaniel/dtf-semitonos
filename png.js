// Codificador PNG propio. El canvas del navegador guarda los colores
// premultiplicados y no deja poner los DPI; aquí se escriben los bytes tal
// cual, RGBA de 8 bits, con el bloque pHYs para que el RIP lea el tamaño real.

'use strict';

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = TABLA_CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function bloque(tipo, datos) {
  const out = new Uint8Array(12 + datos.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, datos.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tipo.charCodeAt(i);
  out.set(datos, 8);
  const crc = crc32(out.subarray(4, 8 + datos.length)) ^ 0xffffffff;
  dv.setUint32(8 + datos.length, crc >>> 0);
  return out;
}

// rgba: Uint8Array/Uint8ClampedArray de w*h*4. dpi: número o null.
export async function codificarPNG(w, h, rgba, dpi) {
  const fila = w * 4;
  const crudo = new Uint8Array((fila + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (fila + 1), s = y * fila;
    // filtro "Sub": muy bueno para semitonos y rápido
    crudo[o] = 1;
    for (let x = 0; x < 4; x++) crudo[o + 1 + x] = rgba[s + x];
    for (let x = 4; x < fila; x++) crudo[o + 1 + x] = (rgba[s + x] - rgba[s + x - 4]) & 0xff;
  }
  const comprimido = new Uint8Array(await new Response(
    new Blob([crudo]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA

  const partes = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), bloque('IHDR', ihdr),
    bloque('sRGB', new Uint8Array([0]))];
  if (dpi) {
    const phys = new Uint8Array(9);
    const pm = Math.round(dpi / 0.0254);
    const d2 = new DataView(phys.buffer);
    d2.setUint32(0, pm); d2.setUint32(4, pm); phys[8] = 1; // por metro
    partes.push(bloque('pHYs', phys));
  }
  partes.push(bloque('IDAT', comprimido), bloque('IEND', new Uint8Array(0)));
  return new Blob(partes, { type: 'image/png' });
}
