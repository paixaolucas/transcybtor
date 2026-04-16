FROM node:20-slim

# Instala ffmpeg e curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Baixa yt-dlp (binário estático para Linux x86_64)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# ffmpeg fica em /usr/bin/ffmpeg — aponta BIN_DIR para lá
# yt-dlp está em /usr/local/bin/yt-dlp (encontrado via PATH pelo transcribe.mjs)
ENV TRANSCYBTOR_BIN_DIR=/usr/bin

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
