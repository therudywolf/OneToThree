FROM node:20-alpine
RUN apk add --no-cache libc6-compat

RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app

WORKDIR /app

COPY package.json ./
RUN npm install && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN chown -R app:app /app

USER app

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
