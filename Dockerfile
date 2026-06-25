FROM node:22-alpine AS base

# Dependências necessárias para Prisma em Alpine
RUN apk add --no-cache openssl libc6-compat

# -------------------------
# Instala dependências
# -------------------------
FROM base AS deps

WORKDIR /app

COPY package*.json ./

RUN npm ci

# -------------------------
# Build da aplicação
# -------------------------
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Garante que a pasta public exista mesmo se o projeto não tiver
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1

# DATABASE_URL necessário no build para prisma generate
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}

RUN npx prisma generate

RUN NEXT_DISABLE_TYPECHECK=1 npm run build

# -------------------------
# Runtime
# -------------------------
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuário não-root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copia saída standalone do Next
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Pasta public pode estar vazia, mas agora sempre existe
COPY --from=builder /app/public ./public

# Prisma necessário em runtime
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

# Ajusta permissões
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node server.js"]
