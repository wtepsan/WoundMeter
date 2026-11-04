FROM node:22-alpine AS dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

WORKDIR /app
COPY app ./app
COPY components ./components
COPY hooks ./hooks
COPY lib ./lib
COPY public ./public
COPY types ./types
COPY next.config.ts next-env.d.ts postcss.config.mjs tsconfig.json ./
# The screens follow the server's demo switch; Compose passes it from the root .env at build time.
ARG WOUNDMETER_DEMO_MODE=false
RUN npm run build

FROM node:22-alpine AS runtime

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=4456

WORKDIR /app
RUN addgroup --system --gid 10001 woundmeter \
    && adduser --system --uid 10001 --ingroup woundmeter woundmeter

COPY --from=builder --chown=woundmeter:woundmeter /app/.next/standalone ./
COPY --from=builder --chown=woundmeter:woundmeter /app/.next/static ./.next/static
COPY --from=builder --chown=woundmeter:woundmeter /app/public ./public

USER woundmeter

EXPOSE 4456

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:4456/ || exit 1

CMD ["node", "server.js"]
