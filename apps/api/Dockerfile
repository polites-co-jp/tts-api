FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# ffmpeg: mp3 / opus / aac / flac への変換と、アップロードされた参照音声の wav 化に使う
RUN apk add --no-cache ffmpeg \
    && mkdir -p /data/voices && chown node:node /data/voices
ENV NODE_ENV=production PORT=8080 VOICES_DIR=/data/voices
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
