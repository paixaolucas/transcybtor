#!/usr/bin/env node
/**
 * create_icon.mjs — Gera transcribe.ico (waveform de áudio) e Transcybtor.lnk
 *
 * Zero dependências externas. Usa apenas Node.js nativo:
 *   - Renderização pixel-a-pixel com SDF (signed distance fields) para AA suave
 *   - Encoder PNG próprio via zlib nativo
 *   - Empacotador ICO binário manual
 */

import { writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CRC32 (necessário para chunks PNG) ─────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─── PNG Encoder ─────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const l = Buffer.allocUnsafe(4);
  l.writeUInt32BE(data.length);
  const c = Buffer.allocUnsafe(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, c]);
}

function encodePng(w, h, pixels /* Buffer RGBA */) {
  // Linha = filter byte (0) + w*4 bytes RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filtro None
    pixels.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 7 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── ICO Builder ─────────────────────────────────────────────────────────────

function buildIco(images /* [{width, height, png}] */) {
  const n = images.length;
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0);
  hdr.writeUInt16LE(1, 2); // type: ICO
  hdr.writeUInt16LE(n, 4);

  const dirs = Buffer.alloc(n * 16);
  let offset = 6 + n * 16;

  images.forEach(({ width: w, height: h, png }, i) => {
    dirs[i * 16 + 0] = w >= 256 ? 0 : w;
    dirs[i * 16 + 1] = h >= 256 ? 0 : h;
    dirs[i * 16 + 2] = 0; dirs[i * 16 + 3] = 0;
    dirs.writeUInt16LE(1, i * 16 + 4);
    dirs.writeUInt16LE(32, i * 16 + 6);
    dirs.writeUInt32LE(png.length, i * 16 + 8);
    dirs.writeUInt32LE(offset, i * 16 + 12);
    offset += png.length;
  });

  return Buffer.concat([hdr, dirs, ...images.map((i) => i.png)]);
}

// ─── Helpers Matemáticos ─────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp  = (a, b, t)   => a + (b - a) * t;
const round = (v)         => Math.round(v);

/**
 * SDF — Retângulo arredondado
 * Centro em (cx, cy), semi-lados (hw, hh), raio de canto r
 * Retorna distância assinada (negativo = dentro)
 */
function sdRRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r;
  const dy = Math.abs(py - cy) - hh + r;
  return (
    Math.min(Math.max(dx, dy), 0) +
    Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) -
    r
  );
}

/**
 * SDF — Cápsula vertical (barra arredondada)
 * Centro em (cx, cy), semi-largura hw (= raio), semi-altura hh
 */
function sdCapsule(px, py, cx, cy, hw, hh) {
  const dy = Math.abs(py - cy) - Math.max(hh - hw, 0);
  return Math.hypot(px - cx, Math.max(dy, 0)) - hw;
}

// ─── Renderizador do Ícone ───────────────────────────────────────────────────

/*
 * Design: Waveform de áudio
 *
 * - Fundo: retângulo arredondado dark blue-navy (#0c1020 → #060a16)
 * - 7 barras verticais com cápsula arredondada
 * - Gradiente ciano claro → teal escuro (topo → base)
 * - Glow suave ao redor das barras
 * - Reflexo sutil no topo do ícone
 */
function renderIcon(size) {
  const s  = size / 256;
  const cx = size / 2;
  const cy = size / 2;

  // Fundo
  const bgHW     = cx - 0.5;
  const bgHH     = cy - 0.5;
  const bgRadius = 40 * s;

  // Barras — design base em 256px:
  //   cada barra: 22px larga (hw=11px), gap=13px entre barras
  const N       = 7;
  const HEIGHTS = [0.27, 0.49, 0.71, 0.92, 0.71, 0.49, 0.27];
  const bHW     = 11 * s;   // semi-largura (raio da cápsula)
  const bGap    = 13 * s;   // espaço entre barras
  const maxBHH  = 112 * s;  // semi-altura máxima

  const totalW  = N * bHW * 2 + (N - 1) * bGap;
  const barLeft = cx - totalW / 2 + bHW; // centro da 1ª barra

  // Paleta
  const BG_TOP  = [12, 16, 32];           // topo do fundo
  const BG_BOT  = [6, 9, 20];            // base do fundo
  const BAR_TOP = [120, 240, 255];        // ciano brilhante
  const BAR_BOT = [0, 140, 180];          // teal
  const GLOW    = [34, 211, 238];         // brilho ao redor das barras
  const GLINT   = [200, 240, 255];        // reflexo no topo

  const GR = 14 * s; // raio do glow em pixels
  const px = Buffer.alloc(size * size * 4, 0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;

      // ── Fundo ──────────────────────────────────────────────────────
      const bgd = sdRRect(fx, fy, cx, cy, bgHW, bgHH, bgRadius);
      if (bgd > 0.8) continue; // fora: transparente

      // Gradiente de fundo (cima → baixo)
      const gt = fy / size;
      let r = lerp(BG_TOP[0], BG_BOT[0], gt);
      let g = lerp(BG_TOP[1], BG_BOT[1], gt);
      let b = lerp(BG_TOP[2], BG_BOT[2], gt);

      // Opacidade: suaviza a borda arredondada com AA
      let a = bgd < -0.5 ? 255 : clamp((0.5 - bgd) * 255, 0, 255);

      // Reflexo sutil no terço superior (simula gradiente de luz)
      if (fy < size * 0.38) {
        const glintT = 1 - fy / (size * 0.38);
        const glintA = glintT * glintT * 0.07;
        r += (GLINT[0] - r) * glintA;
        g += (GLINT[1] - g) * glintA;
        b += (GLINT[2] - b) * glintA;
      }

      // ── Barras ─────────────────────────────────────────────────────
      let minBarD = Infinity;
      let barGT   = 0;

      for (let i = 0; i < N; i++) {
        const bcx = barLeft + i * (bHW * 2 + bGap);
        const bhh = maxBHH * HEIGHTS[i];
        const d   = sdCapsule(fx, fy, bcx, cy, bHW, bhh);
        if (d < minBarD) {
          minBarD = d;
          barGT   = clamp((fy - (cy - bhh)) / (bhh * 2), 0, 1);
        }
      }

      // Glow suave atrás das barras (Gaussian)
      if (minBarD > 0) {
        const glow = Math.exp(-(minBarD * minBarD) / (GR * GR)) * 0.42;
        r += (GLOW[0] - r) * glow;
        g += (GLOW[1] - g) * glow;
        b += (GLOW[2] - b) * glow;
      }

      // Fill das barras com gradiente cima→baixo + brilho de borda
      if (minBarD < 0.8) {
        const barA = minBarD < -0.5 ? 1 : clamp((0.8 - minBarD) / 1.3, 0, 1);

        let br = lerp(BAR_TOP[0], BAR_BOT[0], barGT);
        let bg2 = lerp(BAR_TOP[1], BAR_BOT[1], barGT);
        let bb = lerp(BAR_TOP[2], BAR_BOT[2], barGT);

        // Brilho extra no centro (especular)
        const specular = Math.exp(-barGT * barGT * 8) * 0.3;
        br = lerp(br, 255, specular);
        bg2 = lerp(bg2, 255, specular);
        bb = lerp(bb, 255, specular);

        r = lerp(r, br, barA);
        g = lerp(g, bg2, barA);
        b = lerp(b, bb, barA);
      }

      const idx = (y * size + x) * 4;
      px[idx]     = clamp(round(r), 0, 255);
      px[idx + 1] = clamp(round(g), 0, 255);
      px[idx + 2] = clamp(round(b), 0, 255);
      px[idx + 3] = clamp(round(a), 0, 255);
    }
  }

  return encodePng(size, size, px);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("\n  Gerando ícone Transcybtor...\n");

const SIZES = [16, 32, 48, 256];
const images = SIZES.map((size) => {
  const t0 = Date.now();
  process.stdout.write(`    ${String(size).padStart(3)}×${size}  `);
  const png = renderIcon(size);
  console.log(`${Date.now() - t0}ms  (${png.length} bytes)`);
  return { width: size, height: size, png };
});

const icoPath = join(__dirname, "../assets/transcribe.ico");
writeFileSync(icoPath, buildIco(images));
console.log(`\n  ✓  Ícone salvo: assets/transcribe.ico\n`);

// ─── Criar atalho .lnk com o ícone ──────────────────────────────────────────

const lnkPath = join(__dirname, "../Transcybtor.lnk");
const batPath = join(__dirname, "../transcribe.bat");
const rootDir = join(__dirname, "..");

// Usa um script PS1 temporário para evitar problemas com escape de aspas
const psScript = join(tmpdir(), `criar_lnk_${Date.now()}.ps1`);
writeFileSync(psScript, [
  `$ws = New-Object -ComObject WScript.Shell`,
  `$sc = $ws.CreateShortcut("${lnkPath.replace(/\\/g, "\\\\")}")`,
  `$sc.TargetPath = "${batPath.replace(/\\/g, "\\\\")}"`,
  `$sc.IconLocation = "${icoPath.replace(/\\/g, "\\\\")},0"`,
  `$sc.WorkingDirectory = "${rootDir.replace(/\\/g, "\\\\")}"`,
  `$sc.Description = "Transcybtor - YouTube, TikTok, Instagram, MP3"`,
  `$sc.WindowStyle = 1`,
  `$sc.Save()`,
  `Write-Host "  OK  Atalho criado: Transcybtor.lnk"`,
].join("\n"), "utf-8");

execFileSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript],
  { stdio: "inherit" }
);

try { rmSync(psScript); } catch {}

console.log(
  "\n  Pronto! Use o atalho Transcybtor.lnk para abrir o programa.\n" +
  "  Para criar um atalho na Area de Trabalho, execute: instalar_atalho.bat\n"
);
