# Transcybtor

Transcreve vídeos e áudios para TXT, SRT e JSON — sem servidor, sem API key.

**Suporta:** YouTube · TikTok · Instagram · Twitter/X · Facebook · MP3 · WAV · M4A · e mais.

---

## Como usar

1. **Baixe** o projeto e coloque os binários em `bin/` (veja abaixo)
2. **Dê dois cliques** em `transcribe.bat`
3. **Cole uma URL** ou **arraste um arquivo de áudio** para o terminal
4. Escolha o idioma e o formato de saída
5. A transcrição é salva em `transcripts/<nome-do-video>/`

---

## Dependências (coloque em `bin/`)

| Arquivo | Usado para | Download |
|---|---|---|
| `yt-dlp.exe` | URLs (YouTube, TikTok, etc.) | [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest) |
| `ffmpeg.exe` | Converter áudio para Whisper | [ffmpeg.org](https://ffmpeg.org/download.html) |
| `whisper-cli.exe` + DLLs | Transcrever arquivos locais | [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases/latest) → `whisper-bin-x64.zip` |
| `ggml-base.bin` | Modelo de IA (~142 MB) | [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) |

> O menu de configuração (`transcribe.bat`) pode baixar o `whisper.cpp` e o modelo automaticamente.

### DLLs necessárias (do `whisper-bin-x64.zip`)
`SDL2.dll` · `ggml.dll` · `ggml-base.dll` · `ggml-cpu.dll` · `whisper.dll`

---

## Estrutura do projeto

```
transcybtor/
├── src/
│   ├── transcribe.mjs    # motor principal (yt-dlp + whisper.cpp)
│   ├── menu.mjs          # interface interativa no terminal
│   └── create_icon.mjs   # gerador do ícone (execute uma vez)
├── bin/                  # binários de runtime (não versionados)
├── assets/
│   └── transcribe.ico    # ícone do atalho
├── transcripts/          # saídas geradas (não versionado)
├── transcribe.bat        # launcher principal
└── package.json
```

---

## Formatos de saída

| Formato | Conteúdo |
|---|---|
| `.txt` | Texto com timestamps `[MM:SS]` |
| `.srt` | Legendas prontas para importar |
| `.json` | Dados completos (metadados + segmentos) |

---

## Requisitos

- **Node.js** 18+ — [nodejs.org](https://nodejs.org)
- **Windows 10/11** (o `.bat` e os binários são Windows-only)
- **Visual C++ Redistributable** — necessário para `whisper-cli.exe` ([download](https://aka.ms/vs/17/release/vc_redist.x64.exe))
