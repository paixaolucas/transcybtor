'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
// States: IDLE | RUNNING | SUCCESS | ERROR

let state              = 'IDLE';
let currentEventSource = null;
let uploadedFile       = null;   // File object from browse / drag-drop
let transcriptTitle    = '';     // set from TRANSCYBTOR_TITLE event

// ─── Elements ─────────────────────────────────────────────────────────────────
const urlInput      = document.getElementById('url-input');
const dropZone      = document.getElementById('drop-zone');
const langPills     = document.getElementById('lang-pills');
const fmtToggles    = document.getElementById('fmt-toggles');
const btnTranscribe = document.getElementById('btn-transcribe');

const sectionProgress = document.getElementById('section-progress');
const progressLabel   = document.getElementById('progress-label');
const progressPct     = document.getElementById('progress-pct');
const progressBar     = document.getElementById('progress-bar');
const progressTitle   = document.getElementById('progress-title');

const sectionResult = document.getElementById('section-result');
const resultFiles   = document.getElementById('result-files');
const btnFolder     = document.getElementById('btn-folder');

const sectionError = document.getElementById('section-error');
const errorMsg     = document.getElementById('error-msg');
const btnRetry     = document.getElementById('btn-retry');

// ─── Transcript Viewer elements ───────────────────────────────────────────────
const sectionTranscript = document.getElementById('section-transcript');
const transcriptTabsEl  = document.getElementById('transcript-tabs');
const transcriptStatsEl = document.getElementById('transcript-stats');
const transcriptArea    = document.getElementById('transcript-area');
const searchInput       = document.getElementById('search-input');
const searchCount       = document.getElementById('search-count');
const btnPrev           = document.getElementById('btn-prev');
const btnNext           = document.getElementById('btn-next');
const btnCopyAll        = document.getElementById('btn-copy-all');
const toastEl           = document.getElementById('toast');
const fileInput         = document.getElementById('file-input');

// ─── Getters ──────────────────────────────────────────────────────────────────
function getLanguage() {
  const active = langPills.querySelector('.pill.active');
  return active ? active.dataset.lang : 'auto';
}

function getFormats() {
  return Array.from(fmtToggles.querySelectorAll('.toggle.active'))
    .map(b => b.dataset.fmt);
}

// ─── SSE cleanup ──────────────────────────────────────────────────────────────
function cleanupIpcListeners() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

// ─── State machine ────────────────────────────────────────────────────────────
function transition(newState, payload) {
  state = newState;

  sectionProgress.classList.add('hidden');
  sectionResult.classList.add('hidden');
  sectionError.classList.add('hidden');
  if (newState === 'RUNNING') sectionTranscript.classList.add('hidden');

  if (newState === 'IDLE') {
    btnTranscribe.disabled = false;
    btnTranscribe.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Transcrever`;
    progressBar.classList.remove('running');
    cleanupIpcListeners();
  }

  if (newState === 'RUNNING') {
    btnTranscribe.disabled = true;
    btnTranscribe.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite">
        <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10"/>
      </svg>
      Transcrevendo…`;
    sectionProgress.classList.remove('hidden');
    progressBar.classList.add('running');
    setProgress(0, 'Iniciando…');
    progressTitle.textContent = '';
  }

  if (newState === 'SUCCESS') {
    btnTranscribe.disabled = false;
    btnTranscribe.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Transcrever`;
    progressBar.classList.remove('running');
    cleanupIpcListeners();

    sectionResult.classList.remove('hidden');
    resultFiles.innerHTML = '';
    for (const fmt of ['txt', 'srt', 'json'].filter(f => payload.files[f])) {
      const badge = document.createElement('span');
      badge.className = 'file-badge';
      badge.textContent = fmt.toUpperCase();
      resultFiles.appendChild(badge);
    }
    loadTranscript(payload.files);
  }

  if (newState === 'ERROR') {
    btnTranscribe.disabled = false;
    btnTranscribe.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Transcrever`;
    progressBar.classList.remove('running');
    cleanupIpcListeners();

    sectionError.classList.remove('hidden');
    errorMsg.textContent = payload.message || 'Erro desconhecido.';
  }
}

// ─── Progress helpers ─────────────────────────────────────────────────────────
function setProgress(pct, msg) {
  progressBar.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  progressLabel.textContent = msg;
}

// ─── Transcribe action ────────────────────────────────────────────────────────
async function startTranscribe() {
  if (state === 'RUNNING') return;

  const urlValue = urlInput.value.trim();
  if (!urlValue && !uploadedFile) {
    dropZone.classList.add('shake');
    urlInput.focus();
    dropZone.addEventListener('animationend', () => {
      dropZone.classList.remove('shake');
    }, { once: true });
    return;
  }

  let formats = getFormats();
  if (formats.length === 0) {
    fmtToggles.querySelectorAll('.toggle').forEach(t => t.classList.add('active'));
    formats = getFormats();
  }

  transcriptTitle = '';
  transition('RUNNING');

  let jobId;
  try {
    const formData = new FormData();
    if (uploadedFile) {
      formData.append('file', uploadedFile);
    } else {
      formData.append('url', urlValue);
    }
    formData.append('language', getLanguage());
    formats.forEach(f => formData.append('formats', f));

    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${res.status}`);
    }
    const data = await res.json();
    jobId = data.jobId;
  } catch (err) {
    transition('ERROR', { message: err.message || String(err) });
    return;
  }

  const source = new EventSource(`/api/events/${jobId}`);
  currentEventSource = source;

  source.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'progress') {
      setProgress(ev.pct, ev.msg);
    } else if (ev.type === 'title') {
      progressTitle.textContent = ev.title;
      transcriptTitle = ev.title;
    } else if (ev.type === 'done') {
      source.close();
      currentEventSource = null;
      transition('SUCCESS', { files: ev.files });
    } else if (ev.type === 'error') {
      source.close();
      currentEventSource = null;
      transition('ERROR', { message: ev.message });
    }
  };

  source.onerror = () => {
    if (state === 'RUNNING') {
      source.close();
      currentEventSource = null;
      transition('ERROR', { message: 'Conexão com o servidor perdida.' });
    }
  };
}

// ─── Language pills ───────────────────────────────────────────────────────────
langPills.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  langPills.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
});

// ─── Format toggles ───────────────────────────────────────────────────────────
fmtToggles.addEventListener('click', (e) => {
  const toggle = e.target.closest('.toggle');
  if (!toggle) return;
  toggle.classList.toggle('active');
});

// ─── Submit ───────────────────────────────────────────────────────────────────
btnTranscribe.addEventListener('click', startTranscribe);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startTranscribe();
});

// Limpa arquivo carregado se o usuário digitar uma URL manualmente
urlInput.addEventListener('input', () => {
  if (uploadedFile && urlInput.value !== uploadedFile.name) {
    uploadedFile = null;
  }
});

// ─── Open folder (não aplicável na versão web) ────────────────────────────────
btnFolder.style.display = 'none';

// ─── Retry ───────────────────────────────────────────────────────────────────
btnRetry.addEventListener('click', () => {
  transition('IDLE');
});

// ─── Browse button → input file ───────────────────────────────────────────────
document.getElementById('btn-browse').addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) {
    uploadedFile = file;
    urlInput.value = file.name;
    fileInput.value = ''; // permite re-selecionar o mesmo arquivo
  }
});

// ─── Drag & drop ─────────────────────────────────────────────────────────────
const ACCEPTED_EXTS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
  'wma', 'webm', 'mp4', 'mkv', 'avi', 'mov',
  'vtt', 'srt',
]);

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    dropZone.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const file = e.dataTransfer?.files?.[0];
  if (!file) return;

  const ext = file.name.split('.').pop().toLowerCase();

  if (ACCEPTED_EXTS.has(ext)) {
    uploadedFile = file;
    urlInput.value = file.name;
    urlInput.focus();
  } else {
    dropZone.classList.add('shake');
    dropZone.addEventListener('animationend', () => dropZone.classList.remove('shake'), { once: true });
    urlInput.placeholder = `Tipo não suportado (.${ext}). Use: mp3, wav, ogg, vtt, srt…`;
    setTimeout(() => {
      urlInput.placeholder = 'Cole a URL aqui ou arraste um arquivo de áudio…';
    }, 3000);
  }
});

// ─── Spin animation ───────────────────────────────────────────────────────────
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(spinStyle);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Transcript Viewer ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let transcriptContents = {};   // { txt: '...', srt: '...', json: '...' }
let transcriptFiles    = {};   // não usado na versão web, mantido por compatibilidade
let activeFormat       = '';
let currentTitle       = '';

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// ─── Load transcript (recebe objeto { txt, srt, json } direto do servidor) ────
function loadTranscript(fileContents) {
  if (transcriptTitle) {
    currentTitle = transcriptTitle;
    transcriptTitle = '';
  } else {
    const raw  = urlInput.value.trim().replace(/^["']|["']$/g, '');
    const base = raw.replace(/\\/g, '/').split('/').pop();
    currentTitle = base.replace(/\.[^.]+$/, '') || 'Transcrição';
  }

  transcriptContents = {};
  transcriptFiles    = {};
  activeFormat       = '';

  for (const fmt of ['txt', 'srt', 'json']) {
    if (fileContents[fmt]) transcriptContents[fmt] = fileContents[fmt];
  }

  buildTabs();
  const firstFmt = ['txt', 'srt', 'json'].find(f => transcriptContents[f]);
  if (!firstFmt) return;
  switchTab(firstFmt);
  sectionTranscript.classList.remove('hidden');
  showResultDownloads();
}

function showResultDownloads() {
  const dlEl  = document.getElementById('result-dl');
  const group = document.getElementById('result-dl-group');
  if (!dlEl || !group) return;
  group.innerHTML = '';

  if (transcriptContents.txt) {
    const pdfBtn = document.createElement('button');
    pdfBtn.className = 'dl-btn';
    pdfBtn.textContent = 'PDF';
    pdfBtn.addEventListener('click', downloadPdf);
    group.appendChild(pdfBtn);
  }
  for (const fmt of ['txt', 'srt', 'json']) {
    if (!transcriptContents[fmt]) continue;
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = fmt.toUpperCase();
    btn.addEventListener('click', () => downloadText(fmt));
    group.appendChild(btn);
  }
  dlEl.classList.remove('hidden');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function buildTabs() {
  transcriptTabsEl.innerHTML = '';
  for (const fmt of ['txt', 'srt', 'json']) {
    if (!transcriptContents[fmt]) continue;
    const btn = document.createElement('button');
    btn.className = 't-tab';
    btn.dataset.fmt = fmt;
    btn.textContent = fmt.toUpperCase();
    btn.addEventListener('click', () => switchTab(fmt));
    transcriptTabsEl.appendChild(btn);
  }
}

function switchTab(fmt) {
  if (activeFormat && transcriptContents[activeFormat] !== undefined) {
    transcriptContents[activeFormat] = transcriptArea.value;
  }
  activeFormat = fmt;
  transcriptArea.value = transcriptContents[fmt] || '';
  transcriptTabsEl.querySelectorAll('.t-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === fmt);
  });
  updateStats();
  clearSearch();
  updateDownloadButtons();
}

function updateDownloadButtons() {
  ['txt', 'srt', 'json'].forEach(f => {
    const btn = document.getElementById(`dl-${f}`);
    if (btn) btn.disabled = !transcriptContents[f];
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const txt = transcriptContents.txt || '';
  const textOnly = txt.replace(/\[\d{2}:\d{2}(?::\d{2})?\]\s*/g, '').trim();
  const words    = textOnly ? textOnly.split(/\s+/).filter(Boolean).length : 0;
  const segments = (txt.match(/^\[/gm) || []).length;

  const allTs = [...txt.matchAll(/\[(\d{2}):(\d{2})(?::(\d{2}))?\]/g)];
  let durationStr = '—';
  if (allTs.length > 0) {
    const last = allTs[allTs.length - 1];
    durationStr = last[3]
      ? `${last[1]}:${last[2]}:${last[3]}`
      : `${last[1]}:${last[2]}`;
  }

  transcriptStatsEl.innerHTML =
    `<span>${words.toLocaleString()} palavras</span>` +
    `<span class="stat-dot">·</span>` +
    `<span>${segments} segmentos</span>` +
    `<span class="stat-dot">·</span>` +
    `<span>${durationStr}</span>`;
}

// ─── Search ───────────────────────────────────────────────────────────────────
let searchMatches = [];
let searchIndex   = 0;

function doSearch() {
  const query = searchInput.value;
  if (!query) { clearSearch(); return; }

  const text   = transcriptArea.value;
  const lower  = text.toLowerCase();
  const lQuery = query.toLowerCase();

  searchMatches = [];
  let pos = 0;
  while ((pos = lower.indexOf(lQuery, pos)) !== -1) {
    searchMatches.push(pos);
    pos += lQuery.length;
  }

  if (searchMatches.length === 0) {
    searchCount.textContent = '0 / 0';
    return;
  }
  searchIndex = 0;
  jumpToMatch();
}

function jumpToMatch() {
  if (!searchMatches.length) return;
  const start = searchMatches[searchIndex];
  const end   = start + searchInput.value.length;
  transcriptArea.focus();
  transcriptArea.setSelectionRange(start, end);

  const before = transcriptArea.value.substring(0, start);
  const lineNo  = (before.match(/\n/g) || []).length;
  const lineH   = parseFloat(getComputedStyle(transcriptArea).lineHeight) || 22;
  transcriptArea.scrollTop = Math.max(0, (lineNo - 3) * lineH);

  searchCount.textContent = `${searchIndex + 1} / ${searchMatches.length}`;
}

function clearSearch() {
  searchMatches = [];
  searchIndex   = 0;
  searchCount.textContent = '';
}

searchInput.addEventListener('input', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!searchMatches.length) return;
    searchIndex = (searchIndex + 1) % searchMatches.length;
    jumpToMatch();
    e.preventDefault();
  }
  if (e.key === 'Escape') {
    searchInput.value = '';
    clearSearch();
    transcriptArea.focus();
  }
});

btnPrev.addEventListener('click', () => {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
  jumpToMatch();
});

btnNext.addEventListener('click', () => {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + 1) % searchMatches.length;
  jumpToMatch();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    if (!sectionTranscript.classList.contains('hidden')) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }
});

// ─── Copy all ─────────────────────────────────────────────────────────────────
btnCopyAll.addEventListener('click', async () => {
  if (activeFormat) transcriptContents[activeFormat] = transcriptArea.value;
  const text = transcriptArea.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    transcriptArea.select();
    document.execCommand('copy');
  }
  showToast('Copiado para a área de transferência!');
});

// ─── Downloads ────────────────────────────────────────────────────────────────
function safeFileName(title) {
  return (title || 'transcript')
    .replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '_')
    .trim()
    .slice(0, 60);
}

function downloadText(fmt) {
  if (activeFormat === fmt) transcriptContents[fmt] = transcriptArea.value;
  const content = transcriptContents[fmt];
  if (!content) return;

  const mime = fmt === 'json' ? 'application/json' : 'text/plain';
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${safeFileName(currentTitle)}.${fmt}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Download iniciado!');
}

async function downloadPdf() {
  if (activeFormat) transcriptContents[activeFormat] = transcriptArea.value;
  const txtContent = transcriptContents.txt || transcriptArea.value;
  const name       = safeFileName(currentTitle);
  const now        = new Date().toLocaleDateString('pt-BR');
  const textOnly   = txtContent.replace(/\[\d{2}:\d{2}(?::\d{2})?\]\s*/g, '').trim();
  const wordCount  = textOnly ? textOnly.split(/\s+/).filter(Boolean).length : 0;

  const escape = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const firstLine = (txtContent.split('\n')[0] || '')
    .replace(/^\[\d{2}:\d{2}(?::\d{2})?\]\s*/, '').trim();
  const docTitle = escape(firstLine || currentTitle);

  const body = escape(txtContent)
    .replace(/\[(\d{2}:\d{2}(?::\d{2})?)\]/g,
      '<span class="ts">[$1]</span>');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 11.5pt;
      line-height: 1.9;
      color: #1c1c1e;
      padding: 48px 56px;
      max-width: 820px;
      margin: 0 auto;
    }
    h1 { font-size: 17pt; font-weight: 700; color: #0d0d0f; margin-bottom: 6px; letter-spacing: -0.3px; }
    .meta {
      font-size: 9.5pt; color: #6e7681; margin-bottom: 28px;
      padding-bottom: 14px; border-bottom: 1.5px solid #d1d5da;
      font-family: -apple-system, sans-serif;
    }
    .content { white-space: pre-wrap; word-break: break-word; font-size: 11pt; }
    .ts { color: #0096b7; font-family: 'Consolas', monospace; font-size: 9.5pt; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${docTitle}</h1>
  <div class="meta">${now} &nbsp;·&nbsp; ${wordCount.toLocaleString()} palavras</div>
  <div class="content">${body}</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) {
    win.addEventListener('load', () => {
      win.print();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  } else {
    // Popup bloqueado — baixa como HTML para impressão manual
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Popup bloqueado — HTML baixado para impressão.');
  }
}

document.getElementById('dl-pdf').addEventListener('click', downloadPdf);
document.getElementById('dl-txt').addEventListener('click', () => downloadText('txt'));
document.getElementById('dl-srt').addEventListener('click', () => downloadText('srt'));
document.getElementById('dl-json').addEventListener('click', () => downloadText('json'));
