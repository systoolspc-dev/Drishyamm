FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5000

CMD ["sh", "-c", "npx sequelize-cli db:migrate && (npx sequelize-cli db:seed:all || true) && node src/server.js"]
