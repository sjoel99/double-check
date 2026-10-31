/**
 * Gera os PNGs do ícone (public/icons) a partir da mesma geometria do public/icon.svg,
 * sem dependência de rasterizador: desenha as formas por distância, com 4×4 amostras
 * por pixel, e grava o PNG com o zlib do Node.
 *
 *   pnpm exec tsx apps/approval-web/scripts/icones.ts
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Rgb = [number, number, number];
const BG: Rgb = [0x14, 0x17, 0x1c];
const PAGE: Rgb = [0x0b, 0x0d, 0x10];
const LIME: Rgb = [0xc8, 0xf1, 0x69];
const WHITE: Rgb = [0xed, 0xee, 0xf0];

/** Geometria do icon.svg (viewBox 64): fundo arredondado r=18, dois anéis r=10 com traço 4. */
function draw(size: number, opts: { fullBleed: boolean; scale: number }): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // amostras por eixo
  const u = size / 64; // unidade do viewBox em pixels
  const cx = size / 2;
  const cy = size / 2;
  const sc = opts.scale;
  // Pertence ao fundo arredondado?
  const inRoundRect = (x: number, y: number) => {
    const half = 32 * u;
    const r = 18 * u;
    const dx = Math.max(Math.abs(x - cx) - (half - r), 0);
    const dy = Math.max(Math.abs(y - cy) - (half - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const ring = (x: number, y: number, ox: number, oy: number) => {
    const d = Math.hypot(x - (cx + ox * u * sc), y - (cy + oy * u * sc));
    return Math.abs(d - 10 * u * sc) <= 2 * u * sc;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const x = i + (si + 0.5) / S;
          const y = j + (sj + 0.5) / S;
          let c: Rgb | null = opts.fullBleed ? PAGE : null;
          if (opts.fullBleed || inRoundRect(x, y)) c = BG;
          // Como no SVG: o anel branco é desenhado depois e fica por cima na interseção.
          if (ring(x, y, 7, 0)) c = WHITE;
          else if (ring(x, y, -7, 0)) c = LIME;
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = S * S;
      const o = (j * size + i) * 4;
      // Cor média só das amostras cobertas (sem escurecer a borda com o transparente).
      const covered = a / 255;
      px[o] = covered ? Math.round(r / covered) : 0;
      px[o + 1] = covered ? Math.round(g / covered) : 0;
      px[o + 2] = covered ? Math.round(b / covered) : 0;
      px[o + 3] = Math.round(a / n);
    }
  }
  return png(size, size, px);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w: number, h: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filtro none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });
const files: [string, Buffer][] = [
  ["icon-192.png", draw(192, { fullBleed: false, scale: 1 })],
  ["icon-512.png", draw(512, { fullBleed: false, scale: 1 })],
  // Maskable: o sistema recorta a forma; o fundo ocupa tudo e o desenho fica na zona segura (80%).
  ["maskable-512.png", draw(512, { fullBleed: true, scale: 0.8 })],
  // iOS arredonda sozinho e não aceita transparência: fundo cheio.
  ["apple-touch-icon.png", draw(180, { fullBleed: true, scale: 0.9 })],
];
for (const [name, buf] of files) {
  writeFileSync(join(out, name), buf);
  console.log(`${name}\t${buf.length} bytes`);
}
