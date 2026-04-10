FROM node:20-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
