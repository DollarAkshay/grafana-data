FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src ./src
COPY .env ./

EXPOSE 8005

CMD ["node", "src/index.js"]
