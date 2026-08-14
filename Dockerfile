FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install --global corepack@latest && corepack enable

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY api ./api
RUN pnpm build:api

FROM base AS runtime

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --production
COPY --from=build /app/dist/api ./api
COPY api/database.json ./api/database.json
COPY api/migrations ./api/migrations
COPY api/dim-gg/views ./api/dim-gg/views
COPY api/admin/views ./api/admin/views
COPY dim-gg-static ./dim-gg-static

USER node
EXPOSE 3000

CMD ["node", "--enable-source-maps", "api/index.js"]
