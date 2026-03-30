FROM node:20-slim

# GPU対応パッケージ
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存関係インストール（キャッシュ効率化）
COPY package*.json ./
RUN npm ci --only=production

# アプリケーションコピー
COPY server/ ./server/
COPY public/ ./public/
COPY .env.example ./.env.example

# ストレージディレクトリ作成
RUN mkdir -p /data/db /data/users

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

EXPOSE 3000

CMD ["node", "server/index.js"]
