FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
