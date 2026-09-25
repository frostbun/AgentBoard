# Production image for AgentBoard.
#
# The board only needs the herdr *socket* and the agents' session files; herdr and the agents
# keep running on the host. Mount those in (see docker-compose.yml).
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4317 \
    HOST=0.0.0.0 \
    AGENTBOARD_AGENT_CHECK=off
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
EXPOSE 4317
# The mounted herdr socket belongs to the host uid; override `user:` in compose if not 1000.
USER node
CMD ["npm", "run", "start"]
