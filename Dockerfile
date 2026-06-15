# Hoy backend — production image
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Installs pg for Postgres mode. JSON mode never requires it (lazy require).
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
