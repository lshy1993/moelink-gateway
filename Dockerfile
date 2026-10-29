FROM node:22-alpine
WORKDIR /app
COPY package.json gateway.config.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "src/server.js"]
