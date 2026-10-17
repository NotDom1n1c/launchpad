FROM node:24-alpine
WORKDIR /app
# the app needs only node: drop npm, npx, yarn and corepack (and the CVEs that come with them)
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=8080
COPY package.json ./
COPY src ./src
# numeric uid (= "node"), so Kubernetes can verify runAsNonRoot
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/server.js"]
