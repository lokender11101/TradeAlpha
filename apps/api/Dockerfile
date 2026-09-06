FROM node:20-alpine

WORKDIR /app

# Install openssl for prisma
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/
RUN npm ci

COPY apps/api apps/api

WORKDIR /app/apps/api
RUN npx prisma generate
RUN npm run build

CMD ["npm", "run", "start:api"]
