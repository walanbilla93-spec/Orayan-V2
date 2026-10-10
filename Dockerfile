FROM node:20-alpine

WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend
COPY research/groq-shadow ./research/groq-shadow
COPY research/alibaba-shadow ./research/alibaba-shadow
RUN cd backend && npm ci --omit=dev --no-audit --no-fund

# Settings and trade history persist here — mounted as a volume in docker-compose.yml
# so a container rebuild never throws away trade history or pinned settings.
RUN mkdir -p /app/backend/data

# Give V8 modest headroom above its conservative container auto-limit. The runtime
# still stays well below a 512 MiB service once the research journals are memory-bounded.
ENV NODE_OPTIONS=--max-old-space-size=352
ENV PORT=8080
EXPOSE 8080

# Secrets and deployment safety caps are passed at runtime and never baked into the image.
CMD ["node", "backend/server.js"]
