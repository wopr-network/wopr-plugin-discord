FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY dist ./dist
COPY src/types.ts ./src/

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
