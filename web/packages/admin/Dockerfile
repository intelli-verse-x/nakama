FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV ADMIN_DASHBOARD_BASE_PATH=/admin-dashboard
ENV ADMIN_DASHBOARD_DIST_DIR=/app/dist
ENV ADMIN_DASHBOARD_PORT=8080

COPY dist ./dist
COPY server ./server

# Copilot chat route deps (server/admin-dashboard-server.mjs resolves them by
# walking up from /app/server to /app/node_modules). Kept out of the SPA
# workspace install on purpose — the image has no pnpm workspace.
RUN npm install --no-save --no-audit --no-fund "ai@^7" "@ai-sdk/openai-compatible@^3"

EXPOSE 8080

CMD ["node", "server/admin-dashboard-server.mjs"]
