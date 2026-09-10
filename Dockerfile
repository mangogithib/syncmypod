# SyncMyPod web tool.
#
# Deliberately boring: two npm dependencies (express, pg), no bundler, no native
# modules. That means this image builds on arm64 as fast as it does on amd64,
# which matters because the reference deployment is an Oracle Cloud ARM box.
FROM node:22-alpine

# Run as a non-root user. The app writes nothing to disk - all state is in
# Postgres - so there is no reason for it to own its own files.
WORKDIR /app

# Dependencies first, so a code change does not re-run npm install.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The healthcheck hits an endpoint that also pings Postgres, so an unhealthy
# database shows up as an unhealthy container rather than a 500 in the UI.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
