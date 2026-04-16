# Transcybtor

Transcreve vídeos e áudios para TXT, SRT e JSON — sem servidor, sem API key.

**Suporta:** YouTube · TikTok · Instagram · Twitter/X · Facebook · MP3 · WAV · M4A · e mais.

---

## Mac (terminal)

### 1. Instale o Homebrew (se ainda não tiver)

Abra o Terminal e cole:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> Após a instalação, o Homebrew pode pedir para você rodar dois comandos extras para configurar o PATH — copie e rode os que aparecerem na tela.

### 2. Instale Node.js e yt-dlp

```bash
brew install node yt-dlp
```

### 3. Baixe o projeto

```bash
git clone https://github.com/paixaolucas/transcybtor.git
cd transcybtor
```

### 4. Transcreva

```bash
node src/transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID
```

Os arquivos ficam salvos em `transcripts/` dentro da pasta do projeto.

---

### Exemplos

```bash
# YouTube
node src/transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID

# TikTok
node src/transcribe.mjs https://www.tiktok.com/@usuario/video/123

# Instagram
node src/transcribe.mjs https://www.instagram.com/reel/XXXXX/

# Forçar idioma português
node src/transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID -l pt

# Gerar só TXT (sem SRT e JSON)
node src/transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID -f txt

# Salvar em outra pasta
node src/transcribe.mjs https://www.youtube.com/watch?v=VIDEO_ID -o ~/Desktop/transcrições
```

---

### Formatos de saída

| Arquivo | Conteúdo |
|---|---|
| `.txt` | Texto com timestamps `[MM:SS]` |
| `.srt` | Legendas prontas para importar |
| `.json` | Dados completos (metadados + segmentos) |

---

## Windows

1. Baixe o instalador `Transcybtor-Setup.exe` na aba [Releases](../../releases)
2. Execute e siga o instalador
3. Abra o app pela área de trabalho

---

## Requisitos

| Sistema | Requisitos |
|---|---|
| **Mac** | macOS 11+, [Homebrew](https://brew.sh), Node.js e yt-dlp (instalados pelo passo 2 acima) |
| **Windows** | Windows 10/11, instalador `.exe` disponível nas [Releases](../../releases) |
