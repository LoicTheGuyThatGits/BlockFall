# syntax=docker/dockerfile:1

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies first so this layer caches well.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY src ./src
COPY public ./public

EXPOSE 8080

# Run as a non-root user.
USER node

CMD ["node", "server/index.js"]