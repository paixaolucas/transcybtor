#!/usr/bin/env node

/**
 * transcribe — Transcreve vídeos de YouTube, TikTok, Instagram e outros para TXT, SRT e JSON.
 *
 * Usa yt-dlp para buscar legendas (coloque yt-dlp.exe no mesmo diretório ou no PATH).
 *
 * Fluxo:
 *   1. yt-dlp --dump-json extrai metadados e lista de idiomas
 *   2. yt-dlp baixa a legenda em formato json3 (sem duplicatas)
 *   3. Parseia os segmentos e salva em pasta própria por vídeo
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_WIN = process.platform === "win32";
const EXE    = IS_WIN ? ".exe" : "";

// When packaged, extraResources places bin/ at resources/bin (not alongside src/).
// main.js passes the correct path via TRANSCYBTOR_BIN_DIR.
const BIN_DIR = process.env.TRANSCYBTOR_BIN_DIR || join(__dirname, "../bin");

// ─── Progresso ────────────────────────────────────────────────────────────────
// Emite marcadores de progresso quando stdout é um pipe (chamado pelo menu.mjs).
// Quando rodado direto no terminal (isTTY=true), não faz nada.
function emitProgress(pct, msg) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`TRANSCYBTOR_PROGRESS:${pct}:${msg}\n`);
  }
}

// ─── Duração do áudio via ffmpeg ──────────────────────────────────────────────
function getAudioDuration(audioPath) {
  const ffmpegPath = join(BIN_DIR, `ffmpeg${EXE}`);
  if (!existsSync(ffmpegPath)) return null;
  try {
    execFileSync(ffmpegPath, ["-i", audioPath, "-hide_banner"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
  } catch (e) {
    const out = (e.stderr || Buffer.alloc(0)).toString("utf8");
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (m) {
      return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
    }
  }
  return null;
}

// ─── Input Detection ─────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
  ".wma", ".webm", ".mp4", ".mkv", ".avi", ".mov",
]);

const SUBTITLE_EXTS = new Set([".vtt", ".srt"]);

function isUrl(input) {
  return input.startsWith("http://") || input.startsWith("https://");
}

function isLocalSubtitle(input) {
  const clean = input.replace(/^["']|["']$/g, "");
  return SUBTITLE_EXTS.has(extname(clean).toLowerCase());
}

function isLocalAudio(input) {
  const clean = input.replace(/^["']|["']$/g, "");
  const ext = extname(clean).toLowerCase();
  // Legenda local não é áudio — tratar separadamente
  if (SUBTITLE_EXTS.has(ext)) return false;
  return AUDIO_EXTS.has(ext) || (existsSync(clean) && !isUrl(clean));
}

function validateUrl(url) {
  if (!isUrl(url)) {
    throw new Error(
      `URL inválida: "${url}"\nExemplo: https://www.youtube.com/watch?v=XXXXXXXXXXX`
    );
  }
}

// Extrai o video ID de URLs do YouTube para validação cruzada
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
  } catch {}
  return null;
}

// ─── Whisper.cpp Backend ─────────────────────────────────────────────────────

function findWhisper() {
  const candidates = [
    join(BIN_DIR, `whisper-cli${EXE}`),  // preferred: v1.7+
    join(BIN_DIR, `whisper${EXE}`),
    ...(IS_WIN ? [join(BIN_DIR, "main.exe")] : []),
    join(BIN_DIR, "whisper-cli"),        // macOS bin/ sem extensão
    join(BIN_DIR, "whisper"),
    "whisper-cli",
    "whisper",
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  try {
    execFileSync("whisper", ["--version"], { stdio: "pipe" });
    return "whisper";
  } catch {}
  return null;
}

function findWhisperModel() {
  const names = [
    "ggml-base.bin",
    "ggml-small.bin",
    "ggml-tiny.bin",
    "ggml-medium.bin",
    "ggml-large-v3.bin",
  ];
  for (const n of names) {
    const p = join(BIN_DIR, n);
    if (existsSync(p)) return p;
  }
  return null;
}

// Formats natively supported by whisper.cpp
const WHISPER_NATIVE = new Set([".wav", ".mp3", ".ogg", ".flac"]);

function prepareAudioForWhisper(srcPath) {
  const ffmpegPath = join(BIN_DIR, `ffmpeg${EXE}`);
  const ext = extname(srcPath).toLowerCase();

  // If format is natively supported and ffmpeg isn't available, use as-is
  if (WHISPER_NATIVE.has(ext) && !existsSync(ffmpegPath)) {
    return { path: srcPath, cleanup: false };
  }

  // Convert to 16kHz mono WAV (optimal for Whisper)
  if (existsSync(ffmpegPath)) {
    const wavPath = join(tmpdir(), `whisper-in-${Date.now()}.wav`);
    try {
      execFileSync(
        ffmpegPath,
        ["-i", srcPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }
      );
      return { path: wavPath, cleanup: true };
    } catch {
      // If conversion fails, try native format
    }
  }

  return { path: srcPath, cleanup: false };
}

async function transcribeAudioFile(filePath, language, onProgress) {
  const whisper = findWhisper();
  if (!whisper) {
    throw new Error(
      "whisper.cpp não encontrado.\nExecute transcribe.bat para configurar automaticamente."
    );
  }

  const model = findWhisperModel();
  if (!model) {
    throw new Error(
      "Modelo Whisper não encontrado.\nExecute transcribe.bat e escolha baixar o modelo."
    );
  }

  onProgress?.(10, "Preparando áudio...");
  const { path: audioPath, cleanup } = prepareAudioForWhisper(filePath);
  const totalDuration = getAudioDuration(audioPath);
  const outBase = join(tmpdir(), `whisper-out-${Date.now()}`);

  const whisperArgs = [
    "-m", model,
    "-f", audioPath,
    "-oj",
    "-of", outBase,
    // sem -np: permite capturar linhas de progresso [timestamp --> timestamp]
  ];

  if (language && language !== "auto") {
    whisperArgs.push("-l", language);
  } else {
    whisperArgs.push("-l", "auto");
  }

  onProgress?.(18, "Iniciando Whisper...");

  return new Promise((resolve, reject) => {
    const proc = spawn(whisper, whisperArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Timeout manual de 10 minutos
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Whisper excedeu o tempo limite (10 minutos)."));
    }, 600000);

    // Parse das linhas de progresso do whisper: [HH:MM:SS.mmm --> ...]  texto
    let stdBuf = "";
    proc.stdout.on("data", (d) => {
      stdBuf += d.toString("utf8");
      const lines = stdBuf.split("\n");
      stdBuf = lines.pop() ?? "";
      for (const ln of lines) {
        const m = ln.match(/^\[\s*(\d+):(\d+):(\d+)[.,](\d+)/);
        if (m) {
          const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
          if (totalDuration && totalDuration > 0) {
            const pct = Math.min(88, Math.round(20 + (t / totalDuration) * 68));
            onProgress?.(pct, `Transcrevendo... ${minutagem(t)} / ${minutagem(totalDuration)}`);
          } else {
            onProgress?.(Math.min(85, 20 + Math.round(t * 0.4)), `Transcrevendo... ${minutagem(t)}`);
          }
        }
      }
    });

    proc.stderr.on("data", () => {}); // silencia stderr do whisper

    proc.on("error", (e) => {
      clearTimeout(timer);
      if (cleanup) try { rmSync(audioPath); } catch {}
      reject(e);
    });

    proc.on("close", () => {
      clearTimeout(timer);
      if (cleanup) try { rmSync(audioPath); } catch {}

      const jsonPath = outBase + ".json";
      if (!existsSync(jsonPath)) {
        reject(new Error("whisper.cpp não produziu saída. Verifique se o arquivo de áudio é válido."));
        return;
      }

      const content = readFileSync(jsonPath, "utf-8");
      try { rmSync(jsonPath); } catch {}
      try {
        resolve(JSON.parse(content));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseWhisperOutput(data) {
  return (data.transcription || [])
    .map((seg) => ({
      start: parseWhisperTimestamp(seg.timestamps.from),
      end: parseWhisperTimestamp(seg.timestamps.to),
      text: seg.text.trim(),
    }))
    .filter((s) => s.text);
}

function parseWhisperTimestamp(ts) {
  // "00:00:02,500" → 2.5
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function getLocalFileMetadata(filePath) {
  const name = basename(filePath, extname(filePath));
  return {
    video_id: name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
    title: name,
    duration: 0,
    channel: "Local",
    platform: "local",
    upload_date: null,
  };
}

// ─── yt-dlp Backend ─────────────────────────────────────────────────────────

function findYtDlp() {
  const candidates = [
    join(BIN_DIR, "yt-dlp.exe"),
    join(BIN_DIR, "yt-dlp"),
    "yt-dlp.exe",
    "yt-dlp",
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  try {
    execFileSync("yt-dlp", ["--version"], { stdio: "pipe" });
    return "yt-dlp";
  } catch {}
  throw new Error(
    "yt-dlp não encontrado. Baixe de https://github.com/yt-dlp/yt-dlp e coloque no mesmo diretório ou no PATH."
  );
}

function getVideoInfo(url) {
  const ytDlp = findYtDlp();
  const output = execFileSync(
    ytDlp,
    ["--dump-json", "--no-warnings", "--no-playlist", "--no-cache-dir", url],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }
  );
  // yt-dlp pode emitir múltiplas linhas JSON (playlists ignoradas, warnings, etc.)
  // Pega apenas a primeira linha JSON válida
  const lines = output.toString("utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
  }
  throw new Error("yt-dlp não retornou metadados válidos para esta URL.");
}

// ─── Metadata Extraction ────────────────────────────────────────────────────

function extractMetadata(info) {
  return {
    video_id: info.id,
    title: info.title || "Unknown",
    duration: info.duration || 0,
    channel: info.channel || info.uploader || "Unknown",
    platform: info.extractor_key || info.extractor || "unknown",
    upload_date: info.upload_date || null,
  };
}

// ─── Caption Track Discovery ────────────────────────────────────────────────

// Ordem de preferência de idiomas quando o idioma original do vídeo é desconhecido.
// Evita selecionar idiomas obscuros como "ab" (Abkházia) que aparecem primeiro
// na lista alfabética de traduções automáticas do YouTube.
const LANG_PRIORITY = [
  "pt", "pt-BR", "pt-PT",
  "en", "en-US", "en-GB",
  "es", "es-419",
  "fr", "de", "it", "ja", "ko", "zh", "zh-Hans", "zh-Hant",
  "ar", "hi", "ru", "tr", "nl", "pl", "sv", "da", "fi", "nb",
];

function findCaptionTracks(info) {
  const tracks = [];

  // 1. Legendas manuais (maior prioridade)
  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (formats?.length > 0) {
      tracks.push({
        language: lang,
        name: formats[0].name || lang,
        isAutoGenerated: false,
      });
    }
  }

  const originalLang = info.language;
  const autoCaptions = info.automatic_captions || {};

  // 2. Auto-gerada no idioma original do vídeo (quando conhecido)
  //    NÃO usa !originalLang — isso adicionaria TODOS os idiomas (bug do "ab")
  if (originalLang) {
    for (const [lang, formats] of Object.entries(autoCaptions)) {
      if (!formats?.length) continue;
      if (lang === originalLang || lang.startsWith(originalLang + "-")) {
        tracks.push({
          language: lang,
          name: (formats[0].name || lang) + " (auto)",
          isAutoGenerated: true,
        });
      }
    }
  }

  // 3. Idioma original desconhecido ou nenhuma auto-legenda encontrada:
  //    tenta idiomas na lista de prioridade em vez de pegar o primeiro alfabético
  if (tracks.filter((t) => t.isAutoGenerated).length === 0) {
    for (const pLang of LANG_PRIORITY) {
      let found = false;
      for (const [lang, formats] of Object.entries(autoCaptions)) {
        if (!formats?.length) continue;
        if (lang === pLang || lang.startsWith(pLang + "-")) {
          tracks.push({
            language: lang,
            name: (formats[0].name || lang) + " (auto)",
            isAutoGenerated: true,
          });
          found = true;
          break;
        }
      }
      if (found) break; // para no primeiro idioma prioritário encontrado
    }
  }

  // 4. Último recurso: qualquer auto-legenda disponível
  if (tracks.length === 0) {
    for (const [lang, formats] of Object.entries(autoCaptions)) {
      if (formats?.length > 0) {
        tracks.push({
          language: lang,
          name: (formats[0].name || lang) + " (auto)",
          isAutoGenerated: true,
        });
      }
    }
  }

  return tracks;
}

function selectBestTrack(tracks, preferredLang) {
  if (tracks.length === 0) return null;

  if (preferredLang) {
    const exact = tracks.find((t) => t.language === preferredLang);
    if (exact) return exact;
    const partial = tracks.find((t) => t.language.startsWith(preferredLang));
    if (partial) return partial;
  }

  const manual = tracks.filter((t) => !t.isAutoGenerated);
  if (manual.length > 0) return manual[0];

  return tracks[0];
}

// ─── Subtitle Download via yt-dlp ────────────────────────────────────────────

function downloadSubtitle(url, videoId, language, isAutoGenerated) {
  const ytDlp = findYtDlp();
  const tempDir = join(tmpdir(), `transcribe-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const subArgs = isAutoGenerated
    ? ["--write-auto-sub", "--no-write-sub"]
    : ["--write-sub", "--no-write-auto-sub"];

  // Try json3 first (clean segments, no rolling-window duplicates),
  // then fall back to vtt
  for (const fmt of ["json3", "vtt"]) {
    try {
      execFileSync(
        ytDlp,
        [
          "--skip-download",
          "--no-warnings",
          "--no-playlist",
          "--no-cache-dir",
          ...subArgs,
          "--sub-format", fmt,
          "--sub-langs", language,
          "-o", join(tempDir, "%(id)s"),
          url,
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }
      );

      const files = readdirSync(tempDir);
      // Verifica primeiro se existe arquivo com o ID correto do vídeo
      // (evita pegar legenda de vídeo errado vinda de cache)
      let subFile = files.find((f) => f.startsWith(videoId) && f.endsWith("." + fmt));
      // Fallback: qualquer arquivo com a extensão correta
      if (!subFile) subFile = files.find((f) => f.endsWith("." + fmt));

      if (subFile) {
        // Valida que o arquivo pertence ao vídeo correto
        if (!subFile.startsWith(videoId)) {
          rmSync(tempDir, { recursive: true, force: true });
          throw new Error(
            `Legenda baixada pertence a outro vídeo (esperado ID "${videoId}", arquivo: "${subFile}"). Possível cache corrompido do yt-dlp.`
          );
        }
        const content = readFileSync(join(tempDir, subFile), "utf-8");
        rmSync(tempDir, { recursive: true, force: true });
        if (fmt === "json3") {
          return { format: "json3", data: JSON.parse(content) };
        }
        return { format: "vtt", data: content };
      }
    } catch (e) {
      // Se foi erro de validação de ID, propaga
      if (e.message && e.message.includes("pertence a outro vídeo")) {
        rmSync(tempDir, { recursive: true, force: true });
        throw e;
      }
    }
  }

  rmSync(tempDir, { recursive: true, force: true });
  throw new Error(
    `Não foi possível baixar a legenda no idioma "${language}". Tente --list-langs para ver os idiomas disponíveis.`
  );
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseTimedTextJson(json3) {
  const events = json3.events || [];
  const segments = [];

  for (const ev of events) {
    if (!ev.segs) continue;

    const text = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\n/g, " ")
      .trim();

    if (!text) continue;

    const startMs = ev.tStartMs || 0;
    const durationMs = ev.dDurationMs || 0;

    segments.push({
      start: startMs / 1000,
      end: (startMs + durationMs) / 1000,
      text,
    });
  }

  return deduplicateSegments(segments);
}

function parseVttTime(ts) {
  const parts = ts.split(":");
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return (
    parseInt(parts[0]) * 3600 +
    parseInt(parts[1]) * 60 +
    parseFloat(parts[2])
  );
}

function parseTimedTextVtt(vtt) {
  const segments = [];
  const lines = vtt.split("\n");
  let i = 0;

  while (i < lines.length) {
    const tsMatch = lines[i].match(
      /^(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/
    );

    if (tsMatch) {
      const start = parseVttTime(tsMatch[1]);
      const end = parseVttTime(tsMatch[2]);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        const cleaned = lines[i].replace(/<[^>]+>/g, "").trim();
        if (cleaned) textLines.push(cleaned);
        i++;
      }
      const text = textLines.join(" ").trim();
      if (text) {
        segments.push({ start, end, text });
      }
    } else {
      i++;
    }
  }

  return deduplicateSegments(segments);
}

// SRT usa vírgula como separador de milissegundos: 00:00:01,500
function parseSrtTime(ts) {
  const normalized = ts.replace(",", ".");
  const parts = normalized.split(":");
  return (
    parseInt(parts[0]) * 3600 +
    parseInt(parts[1]) * 60 +
    parseFloat(parts[2])
  );
}

function parseTimedTextSrt(srt) {
  const segments = [];
  // Blocos separados por linha em branco
  const blocks = srt.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    // Primeira linha pode ser número de sequência — ignorar
    const tsLine = lines.find((l) =>
      /\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}/.test(l)
    );
    if (!tsLine) continue;
    const m = tsLine.match(
      /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
    );
    if (!m) continue;
    const start = parseSrtTime(m[1]);
    const end   = parseSrtTime(m[2]);
    // Linhas de texto: tudo após a linha de timestamp
    const tsIdx = lines.indexOf(tsLine);
    const text = lines
      .slice(tsIdx + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text) segments.push({ start, end, text });
  }
  return deduplicateSegments(segments);
}

function parseTimedTextXml(xml) {
  const segments = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const text = m[3]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ")
      .trim();
    if (!text) continue;
    segments.push({ start, end: start + dur, text });
  }
  return deduplicateSegments(segments);
}

// ─── Deduplication ───────────────────────────────────────────────────────────
//
// YouTube's auto-generated captions use a "rolling window" format where
// each cue contains the previous text + new words, causing duplicates:
//   "Hello world"
//   "Hello world how are"   ← skip, next is longer
//   "world how are you"     ← skip, contained in prev
//   "world how are you today" ...
//
// Strategy: if the current segment's text is fully contained in the next
// segment, skip it (the next is more complete). Then remove the overlapping
// prefix carried over from the previous kept segment.

function deduplicateSegments(segments) {
  if (segments.length <= 1) return segments;

  // Pass 1: skip segments whose full text appears in the next segment
  const pass1 = [];
  for (let i = 0; i < segments.length; i++) {
    const curr = segments[i].text.trim();
    const next = i + 1 < segments.length ? segments[i + 1].text.trim() : null;
    if (next && next.includes(curr)) continue; // next is more complete
    pass1.push(segments[i]);
  }

  // Pass 2: remove the overlapping prefix that rolled over from the previous line
  const result = [];
  for (let i = 0; i < pass1.length; i++) {
    if (i === 0) {
      result.push(pass1[i]);
      continue;
    }
    const prev = result[result.length - 1].text;
    const curr = pass1[i].text;
    const cleaned = removeOverlapPrefix(prev, curr);
    if (cleaned.trim()) {
      result.push({ ...pass1[i], text: cleaned.trim() });
    }
  }

  return result;
}

// Find the longest suffix of `prevText` that is a prefix of `currText`
// (word-boundary aligned) and remove it from the start of `currText`.
function removeOverlapPrefix(prevText, currText) {
  const prevWords = prevText.trim().split(/\s+/);
  const currWords = currText.trim().split(/\s+/);
  const maxLen = Math.min(prevWords.length, currWords.length - 1);

  for (let len = maxLen; len >= 2; len--) {
    const suffix = prevWords.slice(-len).join(" ").toLowerCase();
    const prefix = currWords.slice(0, len).join(" ").toLowerCase();
    if (suffix === prefix) {
      return currWords.slice(len).join(" ");
    }
  }
  return currText;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function srtTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function minutagem(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0")
    );
  }
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function formatTxt(segments) {
  return segments.map((s) => `[${minutagem(s.start)}] ${s.text}`).join("\n");
}

function formatSrt(segments) {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.text}\n`
    )
    .join("\n");
}

function formatJson(metadata, segments, language) {
  return JSON.stringify(
    {
      metadata: {
        ...metadata,
        language,
        transcription_source: "captions",
      },
      segments: segments.map((s) => ({
        start: Math.round(s.start * 1000) / 1000,
        end: Math.round(s.end * 1000) / 1000,
        text: s.text,
      })),
      full_text: segments
        .map((s) => `[${minutagem(s.start)}] ${s.text}`)
        .join("\n"),
    },
    null,
    2
  );
}

// ─── File Output ─────────────────────────────────────────────────────────────

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, "_").trim();
}

function writeOutputs(metadata, segments, language, formats, baseOutputDir) {
  // Each video gets its own subfolder
  const folderName = (
    metadata.video_id
      ? `${sanitize(metadata.title)}_${metadata.video_id}`
      : sanitize(metadata.title)
  ).slice(0, 120);
  const videoDir = join(baseOutputDir, folderName);
  mkdirSync(videoDir, { recursive: true });

  // Remove arquivos de formatos NÃO solicitados nesta execução
  // (evita que runs anteriores com todos os formatos "contaminem" runs com formato específico)
  for (const [fmt, ext] of [["txt", ".txt"], ["srt", ".srt"], ["json", ".json"]]) {
    if (!formats.includes(fmt)) {
      const old = join(videoDir, `transcript${ext}`);
      if (existsSync(old)) try { rmSync(old); } catch {}
    }
  }

  const writers = {
    txt: (segs) => formatTxt(segs),
    srt: (segs) => formatSrt(segs),
    json: (segs) => formatJson(metadata, segs, language),
  };
  const exts = { txt: ".txt", srt: ".srt", json: ".json" };
  const written = [];

  for (const fmt of formats) {
    const content = writers[fmt](segments);
    const filePath = join(videoDir, `transcript${exts[fmt]}`);
    writeFileSync(filePath, content, "utf-8");
    written.push(filePath);
  }
  return written;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
transcribe — Transcreve vídeos para TXT, SRT e JSON
Suporta YouTube, TikTok, Instagram, Twitter/X, Facebook e mais.
Requer yt-dlp no mesmo diretório ou no PATH.

Uso:
  node transcribe.mjs <URL> [opções]

Opções:
  -f, --format <fmt...>   Formatos: txt, srt, json (padrão: txt srt json)
  -o, --output-dir <dir>  Diretório de saída (padrão: ./transcripts)
  -l, --language <code>   Idioma preferido (ex: pt, en, es). Auto se omitido.
  --list-langs            Lista idiomas disponíveis para o vídeo
  -h, --help              Mostra esta ajuda

Exemplos:
  node transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID
  node transcribe.mjs https://www.tiktok.com/@user/video/123
  node transcribe.mjs https://www.instagram.com/reel/XXXXX/
  node transcribe.mjs URL -l pt -o ./meus_textos
  node transcribe.mjs URL --list-langs
`);
    process.exit(0);
  }

  let url = null;
  const formats = [];
  let outputDir = join(__dirname, "../transcripts");
  let language = null;
  let listLangs = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-f" || arg === "--format") {
      i++;
      while (i < args.length && !args[i].startsWith("-")) {
        const f = args[i].toLowerCase();
        if (!["txt", "srt", "json"].includes(f)) {
          console.error(`Formato inválido: ${f}. Use: txt, srt, json`);
          process.exit(1);
        }
        formats.push(f);
        i++;
      }
      i--;
    } else if (arg === "-o" || arg === "--output-dir") {
      outputDir = args[++i];
    } else if (arg === "-l" || arg === "--language") {
      language = args[++i];
    } else if (arg === "--list-langs") {
      listLangs = true;
    } else if (!arg.startsWith("-")) {
      url = arg;
    } else {
      console.error(`Opção desconhecida: ${arg}`);
      process.exit(1);
    }
  }

  if (!url) {
    console.error("Erro: forneça uma URL ou caminho de arquivo de áudio.");
    process.exit(1);
  }

  return {
    url,
    formats: formats.length > 0 ? formats : ["txt", "srt", "json"],
    outputDir,
    language,
    listLangs,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { url: input, formats, outputDir, language, listLangs } = parseArgs();

  let metadata, segments, trackLanguage;

  // ── Arquivo de legenda local (.vtt, .srt) — não precisa de Whisper ────────
  if (isLocalSubtitle(input)) {
    const filePath = resolvePath(input.replace(/^["']|["']$/g, ""));
    if (!existsSync(filePath)) {
      throw new Error(`Arquivo não encontrado: ${filePath}`);
    }

    emitProgress(5, "Lendo arquivo de legenda...");
    metadata = getLocalFileMetadata(filePath);
    const ext = extname(filePath).toLowerCase();
    console.log(`Arquivo:    ${basename(filePath)}`);
    console.log(`Formato:    ${ext.slice(1).toUpperCase()}`);

    const content = readFileSync(filePath, "utf-8");
    emitProgress(40, "Processando segmentos...");

    if (ext === ".vtt") {
      segments = parseTimedTextVtt(content);
    } else if (ext === ".srt") {
      segments = parseTimedTextSrt(content);
    } else {
      throw new Error(`Formato de legenda não suportado: ${ext}`);
    }

    trackLanguage = language || "auto";

  // ── Local audio file ──────────────────────────────────────────────────────
  } else if (isLocalAudio(input)) {
    const filePath = resolvePath(input.replace(/^["']|["']$/g, ""));
    if (!existsSync(filePath)) {
      throw new Error(`Arquivo não encontrado: ${filePath}`);
    }

    emitProgress(5, "Verificando arquivo...");
    metadata = getLocalFileMetadata(filePath);
    console.log(`Arquivo:    ${basename(filePath)}`);
    console.log(`Modelo:     ${findWhisperModel() ? findWhisperModel().split(/[\\/]/).pop() : "—"}`);
    console.log("Transcrevendo com Whisper...");

    const whisperData = await transcribeAudioFile(filePath, language, (pct, msg) => {
      emitProgress(pct, msg);
    });

    emitProgress(90, "Processando segmentos...");
    segments = parseWhisperOutput(whisperData);
    trackLanguage = whisperData.result?.language || language || "auto";

  // ── URL (YouTube, TikTok, Instagram, …) ──────────────────────────────────
  } else {
    validateUrl(input);

    emitProgress(5, "Verificando URL...");
    console.log("Buscando informações do vídeo...");
    emitProgress(15, "Buscando informações do vídeo...");
    const info = getVideoInfo(input);

    metadata = extractMetadata(info);

    // Envia título para o menu exibir na linha fixa acima da barra
    if (!process.stdout.isTTY) {
      process.stdout.write(`TRANSCYBTOR_TITLE:${metadata.title}\n`);
    }

    // Validação cruzada: garante que o yt-dlp retornou dados do vídeo correto
    const expectedYtId = extractYouTubeId(input);
    if (expectedYtId && metadata.video_id !== expectedYtId) {
      throw new Error(
        `yt-dlp retornou dados do vídeo errado!\n` +
        `  URL aponta para: ${expectedYtId}\n` +
        `  yt-dlp retornou: ${metadata.video_id} ("${metadata.title}")\n` +
        `Tente novamente — pode ser cache corrompido.`
      );
    }

    console.log(`Plataforma: ${metadata.platform}`);
    console.log(`Título:     ${metadata.title}`);
    console.log(`Canal:      ${metadata.channel}`);
    console.log(`Duração:    ${metadata.duration}s`);

    emitProgress(30, `[${metadata.video_id}] ${metadata.title.slice(0, 36)}`);

    const tracks = findCaptionTracks(info);
    if (tracks.length === 0) {
      console.error("\nNenhuma legenda disponível para este vídeo.");
      process.exit(1);
    }

    if (listLangs) {
      console.log("\nIdiomas disponíveis:");
      for (const t of tracks) {
        const auto = t.isAutoGenerated ? " (auto)" : "";
        console.log(`  ${t.language} — ${t.name}${auto}`);
      }
      process.exit(0);
    }

    const track = selectBestTrack(tracks, language);
    const auto = track.isAutoGenerated ? " (auto-gerada)" : "";
    console.log(`Legenda:    ${track.language} — ${track.name}${auto}`);

    emitProgress(42, `Baixando legenda [${track.language}]...`);
    console.log("Baixando transcrição...");
    const timedText = downloadSubtitle(input, metadata.video_id, track.language, track.isAutoGenerated);

    emitProgress(72, "Processando segmentos...");
    if (timedText.format === "json3") {
      segments = parseTimedTextJson(timedText.data);
    } else if (timedText.format === "vtt") {
      segments = parseTimedTextVtt(timedText.data);
    } else {
      segments = parseTimedTextXml(timedText.data);
    }

    trackLanguage = track.language;
  }

  console.log(`Segmentos:  ${segments.length}`);
  emitProgress(85, `${segments.length} segmentos encontrados`);

  if (segments.length === 0) {
    console.error("Nenhum texto encontrado na transcrição.");
    process.exit(1);
  }

  emitProgress(92, "Salvando arquivos...");
  const written = writeOutputs(metadata, segments, trackLanguage, formats, outputDir);

  console.log("---");
  for (const f of written) {
    console.log(`Salvo: ${f}`);
  }

  emitProgress(100, "Concluído!");
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
