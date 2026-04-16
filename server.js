'use strict';

const express = require('express');
const multer  = require('multer');
const { spawn } = require('child_process');
const { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'renderer')));

const upload = multer({ dest: path.join(os.tmpdir(), 'transcybtor-uploads') });
const jobs   = new Map(); // jobId → { status, events, sseRes, outputDir }

function pushEvent(job, data) {
  job.events.push(data);
  if (job.sseRes) job.sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── POST /api/transcribe ──────────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('file'), (req, res) => {
  let formats = req.body.formats;
  if (!Array.isArray(formats)) formats = formats ? [formats] : ['txt', 'srt', 'json'];

  const language = req.body.language || 'auto';
  const input    = req.file ? req.file.path : (req.body.url || '').trim();

  if (!input) return res.status(400).json({ error: 'URL ou arquivo necessário.' });

  const jobId     = crypto.randomUUID();
  const outputDir = path.join(os.tmpdir(), `transcybtor-${jobId}`);
  mkdirSync(outputDir, { recursive: true });

  const job = { status: 'running', events: [], sseRes: null, outputDir };
  jobs.set(jobId, job);
  res.json({ jobId });

  const scriptPath = path.join(__dirname, 'src', 'transcribe.mjs');
  const binDir     = process.env.TRANSCYBTOR_BIN_DIR || path.join(__dirname, 'bin');

  const args = [scriptPath, input, '-o', outputDir, '-f', ...formats];
  if (language !== 'auto') args.push('-l', language);

  const child = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TRANSCYBTOR_BIN_DIR: binDir },
  });

  let buf    = '';
  let errBuf = '';

  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('TRANSCYBTOR_PROGRESS:')) {
        const rest = line.slice('TRANSCYBTOR_PROGRESS:'.length);
        const i    = rest.indexOf(':');
        pushEvent(job, { type: 'progress', pct: parseInt(rest.slice(0, i), 10), msg: rest.slice(i + 1) });
      } else if (line.startsWith('TRANSCYBTOR_TITLE:')) {
        pushEvent(job, { type: 'title', title: line.slice('TRANSCYBTOR_TITLE:'.length).trim() });
      }
    }
  });

  child.stderr.on('data', chunk => { errBuf += chunk.toString('utf8'); });

  child.on('close', code => {
    if (req.file) try { rmSync(req.file.path); } catch {}

    if (code === 0) {
      const fileContents = {};
      try {
        for (const sub of readdirSync(outputDir)) {
          for (const fmt of formats) {
            const fp = path.join(outputDir, sub, `transcript.${fmt}`);
            if (existsSync(fp)) fileContents[fmt] = readFileSync(fp, 'utf-8');
          }
        }
      } catch {}
      job.status = 'done';
      pushEvent(job, { type: 'done', files: fileContents });
    } else {
      const raw = errBuf.trim() || `Processo encerrado com código ${code}`;
      const msg = raw.replace(/^Erro:\s*/i, '');
      job.status = 'error';
      pushEvent(job, { type: 'error', message: msg });
    }

    if (job.sseRes) { job.sseRes.end(); job.sseRes = null; }

    // Limpa arquivos temporários após 5 min
    setTimeout(() => {
      try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
      jobs.delete(jobId);
    }, 5 * 60_000);
  });
});

// ── GET /api/events/:jobId  (Server-Sent Events) ──────────────────────────────
app.get('/api/events/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Reproduz eventos que já chegaram antes da conexão SSE
  for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (job.status !== 'running') { res.end(); return; }

  job.sseRes = res;
  req.on('close', () => { if (job.sseRes === res) job.sseRes = null; });
});

app.listen(PORT, () => console.log(`Transcybtor em http://localhost:${PORT}`));
