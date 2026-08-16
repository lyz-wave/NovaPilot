# NovaPilot 生产镜像(Node 22 内置 node:sqlite,零原生依赖)
# 构建:docker build -t novapilot .
# 运行:docker run -p 3000:3000 novapilot
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# 免费部署用 /tmp(重启即回到演示初始态);需要持久化时指向挂载盘,
# 例如 NOVAPILOT_DB_PATH=/var/data/novapilot.db
ENV NOVAPILOT_DB_PATH=/tmp/novapilot.db
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
EXPOSE 3000
CMD ["npm", "start"]
