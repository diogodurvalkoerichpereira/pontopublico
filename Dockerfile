# syntax=docker/dockerfile:1

# Imagem de produção. O build do Vite/Nitro com preset node-server emite um
# .output autossuficiente (~7,6 MB) cuja única dependência externa é tslib, que
# o próprio Nitro já copia para .output/server/node_modules. Por isso o estágio
# de runtime não carrega o node_modules do projeto.
#
# A exceção é scripts/db-migrate.mjs, que importa pg em runtime para aplicar as
# migrations de dentro do container. Copiamos apenas a árvore do pg resolvida a
# partir do lockfile, em vez de arrastar todo o node_modules de produção.

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------- build -------
FROM node:${NODE_VERSION} AS build
WORKDIR /app

# --include=dev é obrigatório: vite, typescript e @lovable.dev/vite-tanstack-config
# são devDependencies, e o Coolify injeta NODE_ENV=production também no build.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

# Árvore de dependências do pg 8.22.0, na ordem resolvida pelo lockfile.
RUN mkdir -p /migrator/node_modules \
    && cp -R \
        node_modules/pg \
        node_modules/pg-connection-string \
        node_modules/pg-int8 \
        node_modules/pg-pool \
        node_modules/pg-protocol \
        node_modules/pg-types \
        node_modules/pgpass \
        node_modules/postgres-array \
        node_modules/postgres-bytea \
        node_modules/postgres-date \
        node_modules/postgres-interval \
        node_modules/split2 \
        node_modules/xtend \
        /migrator/node_modules/

# -------------------------------------------------------------- runtime -------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# A imagem slim não traz o banco de fusos: sem tzdata, TZ=America/Sao_Paulo cai
# silenciosamente em UTC. Num sistema de ponto e folha isso vira erro de
# competência sem mensagem de erro.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PGTZ=America/Sao_Paulo \
    HOST=0.0.0.0 \
    PORT=3000 \
    STORAGE_DIR=/data/storage

COPY --from=build /app/.output ./.output
COPY --from=build /migrator/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs
COPY --from=build /app/db ./db
COPY --from=build /app/supabase/migrations ./supabase/migrations

# O upload de atestado e de documento de funcionário grava em disco, não em
# object storage: montar volume persistente em /data/storage pelo Coolify.
# Sem VOLUME declarado aqui de propósito, para não acumular volume anônimo a
# cada redeploy quando o mount já é gerenciado fora da imagem.
RUN mkdir -p /data/storage && chown -R node:node /data/storage

USER node
EXPOSE 3000

# A home responde 200 sem banco, então serve de liveness. Status >= 500 indica
# falha de SSR e derruba o container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
