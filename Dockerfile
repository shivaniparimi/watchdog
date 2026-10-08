# Watchdog server: receives GitHub pull request webhooks and reviews PRs (see README, "Self-hosted server").
FROM node:22-slim

# git: to check out PRs. python3: exact function detection for Python files.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The server is bundled into one file by `npm run build`, so no node_modules are needed at runtime.
COPY dist/server.cjs ./server.cjs

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]
