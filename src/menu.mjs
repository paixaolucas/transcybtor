#!/usr/bin/env node

/**
 * menu.mjs — Interface interativa do Transcybtor
 * Aceita URLs, arquivos de áudio (drag-and-drop) e gerencia o setup do Whisper.
 */

import readline from "node:readline";
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_WIN = process.platform === "win32";
const EXE    = IS_WIN ? ".exe" : "";

// ─── Cores ANSI ──────────────────────────────────────────────────────────────

const C = {
  r:    "\x1b[0m",
  bold: "\x1b[1m",
  dim:  "\x1b[2m",
  cy:   "\x1b[96m",   // cyan claro
  gr:   "\x1b[92m",   // verde
  ye:   "\x1b[93m",   // amarelo
  re:   "\x1b[91m",   // vermelho
  bl:   "\x1b[94m",   // azul
  wh:   "\x1b[97m",   // branco
  gy:   "\x1b[90m",   // cinza
};

const W = 60; // largura da caixa

function strip(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function center(text, width) {
  const len = strip(text).length;
  const pad = Math.max(0, width - len);
  return " ".repeat(Math.floor(pad / 2)) + text + " ".repeat(Math.ceil(pad / 2));
}

function line(char = "─", color = C.gy) {
  return color + char.repeat(W) + C.r;
}

function boxLine(content) {
  const inner = W - 2;
  const len = strip(content).length;
  const pad = Math.max(0, inner - len);
  return `${C.cy}║${C.r}${content}${" ".repeat(pad)}${C.cy}║${C.r}`;
}

function printHeader() {
  console.clear();
  const inner = W - 2;
  console.log();
  console.log(`${C.cy}╔${"═".repeat(inner)}╗${C.r}`);
  console.log(boxLine(center(`${C.bold}${C.wh}  TRANSCYBTOR${C.r}`, inner)));
  console.log(boxLine(center(`${C.gy}YouTube · TikTok · Instagram · MP3 · Áudio${C.r}`, inner)));
  console.log(`${C.cy}╚${"═".repeat(inner)}╝${C.r}`);
  console.log();
}

// ─── Input ───────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt) {
  return new Promise((res) => rl.question(prompt, (a) => res(a.trim())));
}

function close() {
  rl.close();
  process.stdout.write("\x1b[?25h");
}

// ─── Dependências ────────────────────────────────────────────────────────────

function findModel() {
  const names = [
    "ggml-base.bin", "ggml-small.bin", "ggml-tiny.bin",
    "ggml-medium.bin", "ggml-large-v3.bin",
  ];
  for (const n of names) {
    const p = join(__dirname, "../bin", n);
    if (existsSync(p)) return p;
  }
  return null;
}

function findWhisperExe() {
  const names = IS_WIN
    ? ["whisper-cli.exe", "main.exe", "whisper.exe"]
    : ["whisper-cli", "whisper"];
  for (const n of names) {
    const p = join(__dirname, "../bin", n);
    if (existsSync(p)) return p;
  }
  return null;
}

async function checkDeps() {
  const hasYtdlp   = existsSync(join(__dirname, `../bin/yt-dlp${EXE}`));
  const whisperExe = findWhisperExe();
  const modelPath  = findModel();

  // Tudo OK → linha compacta, sem poluir a tela
  if (hasYtdlp && whisperExe && modelPath) {
    console.log(`  ${C.gr}✓${C.r}  ${C.gy}yt-dlp · whisper · ${basename(modelPath)}${C.r}`);
    console.log(line());
    console.log();
    return;
  }

  const ok   = `${C.gr}✓${C.r}`;
  const warn = `${C.ye}○${C.r}`;
  const bad  = `${C.re}✗${C.r}`;

  console.log(`  ${hasYtdlp  ? ok : bad}  yt-dlp       ${hasYtdlp  ? C.gy + "(URLs)" + C.r : C.ye + "— não encontrado" + C.r}`);
  console.log(`  ${whisperExe ? ok : warn}  whisper.cpp  ${whisperExe ? C.gy + "(áudio local)" + C.r : C.ye + "— não configurado" + C.r}`);
  console.log(`  ${modelPath  ? ok : warn}  modelo IA    ${modelPath  ? C.gy + "(" + basename(modelPath) + ")" + C.r : C.ye + "— não baixado" + C.r}`);
  console.log();

  if (!whisperExe || !modelPath) {
    console.log(`  ${C.ye}⚠${C.r}  Para transcrever áudios locais, configure o Whisper.`);
    console.log();
    const resp = await ask(`  Configurar agora? ${C.gy}[S/n]${C.r} `);
    if (resp.toLowerCase() !== "n") {
      await setupWhisper(!whisperExe, !modelPath);
    }
  }

  console.log(line());
  console.log();
}

async function setupWhisper(needExe, needModel) {
  console.log();

  if (needExe) {
    console.log(`  ${C.cy}↓${C.r}  Baixando whisper.cpp...`);
    try {
      await downloadWhisperExe();
      console.log(`  ${C.gr}✓${C.r}  whisper.cpp instalado.`);
    } catch (e) {
      console.log(`  ${C.re}✗${C.r}  Falha: ${e.message}`);
      console.log(`  ${C.gy}   Baixe manualmente: https://github.com/ggerganov/whisper.cpp/releases${C.r}`);
    }
    console.log();
  }

  if (needModel) {
    console.log(`  ${C.ye}Escolha o modelo de IA:${C.r}`);
    console.log();
    console.log(`    ${C.wh}[1]${C.r} Tiny   ${C.gy}75 MB  — rápido, menos preciso${C.r}`);
    console.log(`    ${C.wh}[2]${C.r} Base   ${C.gy}142 MB — equilíbrio (recomendado)${C.r}`);
    console.log(`    ${C.wh}[3]${C.r} Small  ${C.gy}466 MB — mais preciso, mais lento${C.r}`);
    console.log();
    const choice = await ask(`  ${C.cy}➤${C.r}  Escolha [1-3] (padrão 2): `);
    const names  = { "1": "tiny", "2": "base", "3": "small" };
    const name   = names[choice] || "base";

    console.log();
    console.log(`  ${C.cy}↓${C.r}  Baixando modelo ${C.wh}${name}${C.r}... ${C.gy}(pode demorar)${C.r}`);
    try {
      downloadModel(name);
      console.log(`  ${C.gr}✓${C.r}  Modelo ${name} pronto.`);
    } catch (e) {
      console.log(`  ${C.re}✗${C.r}  Falha: ${e.message}`);
    }
    console.log();
  }
}

function downloadWhisperExe() {
  mkdirSync(join(__dirname, "../bin"), { recursive: true });

  if (IS_WIN) {
    const dest = join(__dirname, "../bin/whisper-cli.exe").replace(/\\/g, "\\\\");
    const ps = `
      $api = Invoke-WebRequest -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest' -UseBasicParsing | ConvertFrom-Json;
      $tag = $api.tag_name;
      $url = "https://github.com/ggerganov/whisper.cpp/releases/download/$tag/whisper-blas-bin-x64.zip";
      Write-Host "  Versao: $tag";
      $tmp = "$env:TEMP\\whisper-dl.zip";
      $ext = "$env:TEMP\\whisper-dl-ext";
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing;
      if (Test-Path $ext) { Remove-Item $ext -Recurse -Force };
      Expand-Archive -Path $tmp -DestinationPath $ext;
      $exe = Get-ChildItem -Path $ext -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1;
      if (-not $exe) { $exe = Get-ChildItem -Path $ext -Recurse -Filter 'main.exe' | Select-Object -First 1 };
      if ($exe) { Copy-Item $exe.FullName '${dest}' -Force; Write-Host 'OK' } else { throw 'Executavel nao encontrado no zip' };
      Remove-Item $tmp, $ext -Recurse -Force;
    `;
    execFileSync("powershell", ["-Command", ps], { stdio: "inherit", timeout: 180000 });
  } else {
    // macOS: instala via Homebrew
    try {
      execFileSync("brew", ["install", "whisper-cpp"], { stdio: "inherit", timeout: 300000 });
    } catch {
      throw new Error(
        "Homebrew não encontrado. Instale em https://brew.sh e execute:\n" +
        "  brew install whisper-cpp ffmpeg yt-dlp"
      );
    }
    for (const bin of ["whisper-cli", "whisper"]) {
      try {
        const src = execFileSync("which", [bin], { encoding: "utf8" }).trim();
        if (src) {
          const dest = join(__dirname, "../bin/whisper-cli");
          execFileSync("cp", [src, dest]);
          execFileSync("chmod", ["+x", dest]);
          return;
        }
      } catch {}
    }
    throw new Error("whisper-cli não encontrado após instalação. Tente: brew install whisper-cpp");
  }
}

function downloadModel(name) {
  mkdirSync(join(__dirname, "../bin"), { recursive: true });
  const url  = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
  const dest = join(__dirname, "../bin", `ggml-${name}.bin`);

  if (IS_WIN) {
    const destEsc = dest.replace(/\\/g, "\\\\");
    const ps = `
      Write-Host '  Conectando a Hugging Face...';
      Invoke-WebRequest -Uri '${url}' -OutFile '${destEsc}' -UseBasicParsing;
      Write-Host 'OK';
    `;
    execFileSync("powershell", ["-Command", ps], { stdio: "inherit", timeout: 600000 });
  } else {
    execFileSync("curl", ["-L", "--progress-bar", url, "-o", dest], { stdio: "inherit", timeout: 600000 });
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Habilita ANSI no Windows (silencia erros)
  if (IS_WIN) {
    try {
      execFileSync(
        "reg", ["add", "HKCU\\Console", "/v", "VirtualTerminalLevel",
                 "/t", "REG_DWORD", "/d", "1", "/f"],
        { stdio: "ignore" }
      );
    } catch {}
  }

  printHeader();
  await checkDeps();

  // ─── Input ───────────────────────────────────────────────────────────────

  let input = (process.argv[2] || "").replace(/^["']|["']$/g, "");

  if (input) {
    const label = input.startsWith("http") ? "URL" : "Arquivo";
    console.log(`  ${C.gy}${label} detectado:${C.r}`);
    console.log(`  ${C.wh}${input}${C.r}`);
    console.log();
  } else {
    console.log(`  ${C.ye}Cole a URL ou arraste um arquivo de áudio aqui:${C.r}`);
    console.log();
    input = (await ask(`  ${C.cy}➤${C.r}  `)).replace(/^["']|["']$/g, "");
    console.log();
  }

  if (!input) {
    console.log(`  ${C.re}Nenhum input fornecido. Encerrando.${C.r}`);
    close();
    return;
  }

  // ─── Idioma ───────────────────────────────────────────────────────────────

  console.log(line());
  console.log();
  console.log(`  ${C.ye}Idioma da transcrição:${C.r}`);
  console.log();
  console.log(`    ${C.wh}[1]${C.r} Automático ${C.gy}(recomendado)${C.r}`);
  console.log(`    ${C.wh}[2]${C.r} Português`);
  console.log(`    ${C.wh}[3]${C.r} Inglês`);
  console.log(`    ${C.wh}[4]${C.r} Espanhol`);
  console.log(`    ${C.wh}[5]${C.r} Outro`);
  console.log();
  const lc = await ask(`  ${C.cy}➤${C.r}  Escolha [1-5] (Enter = Auto): `);

  const langMap = { "2": "pt", "3": "en", "4": "es" };
  let language  = langMap[lc] ?? null;
  if (lc === "5") {
    language = await ask(`  ${C.cy}➤${C.r}  Código (ex: fr, de, ja): `);
  }

  const langLabel = language ? language.toUpperCase() : "Automático";
  console.log(`\n  ${C.gr}✓${C.r}  Idioma: ${C.wh}${langLabel}${C.r}`);

  // ─── Formato ─────────────────────────────────────────────────────────────

  console.log();
  console.log(line());
  console.log();
  console.log(`  ${C.ye}Formato de saída:${C.r}`);
  console.log();
  console.log(`    ${C.wh}[1]${C.r} Todos  ${C.gy}(TXT + SRT + JSON)${C.r}`);
  console.log(`    ${C.wh}[2]${C.r} TXT    ${C.gy}(texto com timestamps)${C.r}`);
  console.log(`    ${C.wh}[3]${C.r} SRT    ${C.gy}(legendas)${C.r}`);
  console.log(`    ${C.wh}[4]${C.r} JSON   ${C.gy}(dados completos)${C.r}`);
  console.log();
  const fc = await ask(`  ${C.cy}➤${C.r}  Escolha [1-4] (Enter = Todos): `);

  const fmtMap = { "2": ["txt"], "3": ["srt"], "4": ["json"] };
  const formats = fmtMap[fc] ?? ["txt", "srt", "json"];
  console.log(`\n  ${C.gr}✓${C.r}  Formato: ${C.wh}${formats.join(" + ").toUpperCase()}${C.r}`);

  // ─── Transcrição ──────────────────────────────────────────────────────────

  const transcriptsDir = join(__dirname, "../transcripts");
  const args = [join(__dirname, "transcribe.mjs"), input, "-f", ...formats, "-o", transcriptsDir];
  if (language) args.push("-l", language);

  console.log();
  console.log(line());
  console.log();

  // ── Barra de progresso ────────────────────────────────────────────────────
  const BAR_W = 36;
  let progPct = 0;
  let progMsg = "Iniciando...";
  let progTitle = "";       // título do vídeo (chega via TRANSCYBTOR_TITLE:)
  let barStarted = false;   // controla se já renderizamos as 2 linhas

  function drawBar() {
    const filled = Math.round(progPct / 100 * BAR_W);
    const bar = C.cy + "█".repeat(filled) + C.gy + "░".repeat(BAR_W - filled) + C.r;
    const pctStr = `${String(progPct).padStart(3)}%`;
    const label = progMsg.slice(0, 36).padEnd(36);

    if (barStarted) {
      // Sobe 1 linha para reescrever o título + barra
      process.stdout.write("\x1b[1A\r");
    }

    // Linha 1: título fixo do vídeo
    const titleDisplay = progTitle
      ? `  ${C.cy}▸${C.r} ${C.wh}${progTitle.slice(0, W - 4)}${C.r}`
      : `  ${C.gy}Buscando informações do vídeo...${C.r}`;
    process.stdout.write(`\x1b[2K${titleDisplay}\n`);

    // Linha 2: barra de progresso
    process.stdout.write(`\x1b[2K  ${bar} ${C.wh}${pctStr}${C.r}  ${C.gy}${label}${C.r}`);

    barStarted = true;
  }

  drawBar();

  const child = spawn("node", args, {
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdBuf = "";
  const savedFiles = [];
  child.stdout.on("data", (d) => {
    stdBuf += d.toString("utf8");
    const lines = stdBuf.split("\n");
    stdBuf = lines.pop() ?? "";
    for (const ln of lines) {
      if (ln.startsWith("TRANSCYBTOR_TITLE:")) {
        progTitle = ln.slice("TRANSCYBTOR_TITLE:".length).trim();
        drawBar();
      } else if (ln.startsWith("TRANSCYBTOR_PROGRESS:")) {
        const rest = ln.slice("TRANSCYBTOR_PROGRESS:".length);
        const idx = rest.indexOf(":");
        if (idx !== -1) {
          progPct = Math.min(100, parseInt(rest.slice(0, idx)) || progPct);
          progMsg = rest.slice(idx + 1).trim();
          drawBar();
        }
      } else if (ln.startsWith("Salvo: ")) {
        savedFiles.push(ln.slice("Salvo: ".length).trim());
      }
    }
  });

  let errText = "";
  child.stderr.on("data", (d) => { errText += d.toString("utf8"); });

  const exitCode = await new Promise((res) => {
    child.on("close", res);
    child.on("error", () => res(1));
  });

  // Garante barra em 100% se sucesso
  if (exitCode === 0) { progPct = 100; progMsg = "Concluído!"; drawBar(); }
  process.stdout.write("\n");
  console.log();

  if (exitCode === 0) {
    console.log(`${C.gr}${"─".repeat(W)}${C.r}`);
    console.log();
    console.log(`  ${C.gr}✓${C.r}  ${C.bold}Transcrição concluída com sucesso!${C.r}`);
    console.log();

    if (savedFiles.length > 0) {
      // Mostra pasta (relativa) e formatos salvos — mais limpo que paths absolutos longos
      const folderPath = dirname(savedFiles[0]);
      const relFolder = folderPath.startsWith(transcriptsDir)
        ? "transcripts\\" + folderPath.slice(transcriptsDir.length).replace(/^[\\/]/, "")
        : folderPath;
      const fmts = savedFiles.map((f) => f.split(".").pop().toUpperCase()).join(" · ");
      console.log(`  ${C.gy}Pasta:${C.r}    ${C.wh}${relFolder}${C.r}`);
      console.log(`  ${C.gy}Arquivos:${C.r} ${C.gy}${fmts}${C.r}`);
      console.log();
      const ans = await ask(`  ${C.cy}[A]${C.r} Abrir pasta  ${C.gy}[Enter]${C.r} Fechar: `);
      if (ans.toLowerCase() === "a") {
        try {
          const opener = IS_WIN ? "explorer.exe" : "open";
          spawn(opener, [folderPath], { detached: true, stdio: "ignore" }).unref();
        } catch {}
      }
    } else {
      await ask(`  Pressione ${C.wh}Enter${C.r} para fechar...`);
    }
  } else {
    console.log(`${C.re}${"─".repeat(W)}${C.r}`);
    console.log();
    console.log(`  ${C.re}✗${C.r}  Ocorreu um erro na transcrição.`);
    if (errText.trim()) {
      console.log();
      const lastLines = errText.trim().split("\n").slice(-3).join(`\n  `);
      console.log(`  ${C.gy}${lastLines}${C.r}`);
    }
    console.log();
    await ask(`  Pressione ${C.wh}Enter${C.r} para fechar...`);
  }

  close();
}

main().catch((err) => {
  console.error(`\n  ${C.re}Erro:${C.r} ${err.message}`);
  close();
  process.exit(1);
});
