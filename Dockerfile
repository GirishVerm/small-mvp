FROM node:20-slim

# better-sqlite3 needs build tools to compile its native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

ENV PORT=8080
ENV ANALYTICS_DB_PATH=/data/analytics.db

EXPOSE 8080
CMD ["node", "src/server.js"]
