'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// Disable GPU process — prevents blank-window crash in portable/extracted environments
// and reduces CPU + RAM usage considerably
app.disableHardwareAcceleration();

// When packaged, preload must be a real filesystem path (outside asar).
// asarUnpack copies it to app.asar.unpacked/ — point there when installed.
const preloadPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
  : path.join(__dirname, 'preload.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 900,
    minWidth: 520,
    minHeight: 560,
    backgroundColor: '#0d1117',
    titleBarStyle: 'default',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  return win;
}

let mainWin = null;

app.whenReady().then(() => {
  mainWin = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWin = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: transcribe ────────────────────────────────────────────────────────

ipcMain.handle('transcribe', (event, { url, language, formats }) => {
  return new Promise((resolve, reject) => {
    // src/ is asarUnpacked → real filesystem path when installed
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'transcribe.mjs')
      : path.join(__dirname, 'src', 'transcribe.mjs');
    // Write transcripts to userData (writable in installed app)
    const outputDir = app.isPackaged
      ? path.join(app.getPath('userData'), 'transcripts')
      : path.join(__dirname, 'transcripts');

    // Bin dir differs between packaged (extraResources → resources/bin)
    // and dev mode (project root /bin). Pass it so transcribe.mjs can find binaries.
    const binDir = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, 'bin');

    const args = [scriptPath, url];
    if (language && language !== 'auto') {
      args.push('-l', language);
    }
    if (formats && formats.length > 0) {
      args.push('-f', ...formats);
    }
    args.push('-o', outputDir);

    // Try 'node' first; fall back to electron running as node
    const spawnOpts = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TRANSCYBTOR_BIN_DIR: binDir },
    };

    let triedFallback = false;

    function spawnNode(exe, extraEnv) {
      const opts = { ...spawnOpts, env: { ...spawnOpts.env, ...extraEnv } };
      return spawn(exe, args, opts);
    }

    function attachHandlers(child, currentExe) {
      const sender = event.sender;
      const savedFiles = [];
      let stdoutBuf = '';
      let stderrBuf = '';

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('TRANSCYBTOR_PROGRESS:')) {
            const parts = line.slice('TRANSCYBTOR_PROGRESS:'.length).split(':');
            const pct = parseInt(parts[0], 10);
            const msg = parts.slice(1).join(':');
            if (!sender.isDestroyed()) {
              sender.send('progress', { pct, msg });
            }
          } else if (line.startsWith('TRANSCYBTOR_TITLE:')) {
            const title = line.slice('TRANSCYBTOR_TITLE:'.length).trim();
            if (!sender.isDestroyed()) {
              sender.send('title', { title });
            }
          } else if (line.startsWith('Salvo: ')) {
            savedFiles.push(line.slice('Salvo: '.length).trim());
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (err.code === 'ENOENT' && currentExe === 'node' && !triedFallback) {
          // node not in PATH — retry with electron's own Node
          triedFallback = true;
          const fallback = spawnNode(process.execPath, { ELECTRON_RUN_AS_NODE: '1' });
          attachHandlers(fallback, process.execPath);
        } else {
          reject(new Error(`Falha ao iniciar o processo: ${err.message}`));
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          const folder = savedFiles.length > 0
            ? path.dirname(savedFiles[0])
            : path.join(__dirname, 'transcripts');
          resolve({ files: savedFiles, folder });
        } else {
          const msg = stderrBuf.trim() || `Processo encerrado com código ${code}`;
          reject(new Error(msg));
        }
      });
    }

    const proc = spawnNode('node', {});
    attachHandlers(proc, 'node');
  });
});

// ─── IPC: openFilePicker ─────────────────────────────────────────────────────

ipcMain.handle('openFilePicker', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWin;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Áudio e Legendas', extensions: ['mp3','wav','m4a','aac','flac','ogg','opus','wma','webm','mp4','mkv','avi','mov','vtt','srt'] },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ─── IPC: openFolder ────────────────────────────────────────────────────────

ipcMain.handle('openFolder', (_event, folderPath) => {
  shell.openPath(folderPath);
});

// ─── IPC: readFile ───────────────────────────────────────────────────────────

ipcMain.handle('readFile', (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

// ─── IPC: saveFile ───────────────────────────────────────────────────────────

ipcMain.handle('saveFile', async (_event, { defaultName, content, filters }) => {
  const win = BrowserWindow.getFocusedWindow() || mainWin;
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'Texto', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return { filePath: result.filePath };
});

// ─── IPC: exportPdf ──────────────────────────────────────────────────────────

ipcMain.handle('exportPdf', async (_event, { html, defaultName }) => {
  const win = BrowserWindow.getFocusedWindow() || mainWin;
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const tmpPath = path.join(os.tmpdir(), `transcript-pdf-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, 'utf-8');

  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  try {
    await pdfWin.loadFile(tmpPath);
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: false,
      pageSize: 'A4',
    });
    fs.writeFileSync(result.filePath, pdfBuffer);
    return { filePath: result.filePath };
  } finally {
    pdfWin.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});
