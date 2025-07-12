FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# Use the same port as your app (default 8005, can be overridden by env)
EXPOSE 8005

CMD ["node", "src/index.js"]
