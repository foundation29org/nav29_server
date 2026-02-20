FROM node:22.13.1-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.13.1-alpine

RUN apk add --no-cache tini
ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN cp config.container.js config.js && \
    addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8443

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
