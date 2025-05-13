# 1) Etapa de build
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Copiem package.json i lock
COPY package*.json ./

# Instal·lem dependències
RUN npm ci

# Copiem tot el codi i compilem
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# 2) Etapa de runtime
FROM node:22-alpine

WORKDIR /usr/src/app

# Només copy la carpeta de producció + package.json sinó no hem de fer install novament
COPY package*.json ./
RUN npm ci --omit=dev

# Copiem build output
COPY --from=builder /usr/src/app/dist ./dist

# Exposem port TCP (3039) i HTTP (3111 si vols debug via HTTP)
EXPOSE 3039 3111

# Arranquem la build compilada
CMD ["node", "dist/main.js"]
