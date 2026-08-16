# No npm dependencies exist in this project (Node built-ins only), so this image is
# just "copy the files onto a Node runtime" — no build stage, no node_modules layer.
FROM node:20-alpine

WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend

# Settings and trade history persist here — mounted as a volume in docker-compose.yml
# so a container rebuild never throws away trade history or pinned settings.
RUN mkdir -p /app/backend/data

ENV PORT=8080
EXPOSE 8080

# Bybit API key/secret are the only env vars this app reads — passed in at `docker run`
# or via docker-compose.yml, never baked into the image.
CMD ["node", "backend/server.js"]
