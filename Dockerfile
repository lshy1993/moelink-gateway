FROM node:22-alpine
WORKDIR /app
COPY package.json gateway.config.json ./
COPY src ./src
# 构建版本号；留空时在镜像构建时生成时间戳，保证每次 rebuild 都可区分
ARG GATEWAY_BUILD_VERSION=
ENV GATEWAY_BUILD_VERSION=$GATEWAY_BUILD_VERSION
RUN if [ -z "$GATEWAY_BUILD_VERSION" ]; then date -u +%Y%m%d-%H%M > BUILD_VERSION; fi
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "src/server.js"]
