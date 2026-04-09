# Next.js 14 — development image (Alpine, hot-reload friendly)
FROM node:20-alpine

RUN apk add --no-cache libc6-compat

WORKDIR /app

# Install dependencies (cached layer when package.json changes)
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

# Bind-mount workflows override /app; compose runs `npm install` then `next dev`.
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0", "--port", "3000"]
