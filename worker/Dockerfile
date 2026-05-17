# Railway transcode worker. ffmpeg comes from Debian repos so it stays
# in lock-step with the system libs; no need to bundle a static binary
# like the Vercel function does.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

ENV NODE_ENV=production
CMD ["npx", "tsx", "worker.ts"]
