FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=8787

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "index.js"]
