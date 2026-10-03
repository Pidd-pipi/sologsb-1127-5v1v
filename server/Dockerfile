FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
# 数据文件目录（默认 /app/data/db.json，容器无状态，重启即重置；需要留存可自行挂卷）
RUN mkdir -p /app/data
ENV PORT=4021
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4021/api/health || exit 1
CMD ["node", "src/index.js"]
