FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
COPY src ./src
# numeric uid (= "node"), so Kubernetes can verify runAsNonRoot
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/server.js"]
