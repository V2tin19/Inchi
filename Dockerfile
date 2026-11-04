FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || true

COPY . .

RUN mkdir -p /app/data

EXPOSE 8792

ENV NODE_ENV=production
ENV PORT=8792

VOLUME ["/app/data"]

CMD ["node", "server.mjs"]
