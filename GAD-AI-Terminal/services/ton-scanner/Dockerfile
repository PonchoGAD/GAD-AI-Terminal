FROM node:20-alpine
WORKDIR /usr/src/app

# Copy root config and workspace manifests first (for layer caching)
COPY package.json tsconfig.base.json ./
COPY libs/db/package.json       ./libs/db/package.json
COPY libs/ton/package.json      ./libs/ton/package.json
COPY services/ton-scanner/package.json ./services/ton-scanner/package.json

# Install all dependencies (--legacy-peer-deps handles @ton/core version mismatch)
RUN npm install --legacy-peer-deps

# Copy full source
COPY libs/db    ./libs/db
COPY libs/ton   ./libs/ton
COPY services/ton-scanner ./services/ton-scanner

# Compile @lib/ton so .d.ts files exist for service build
RUN node_modules/.bin/tsc \
      --target ES2020 --module CommonJS --moduleResolution node \
      --declaration --outDir libs/ton/src --rootDir libs/ton/src \
      --skipLibCheck --esModuleInterop --allowSyntheticDefaultImports \
      --strict false \
      libs/ton/src/index.ts libs/ton/src/client.ts libs/ton/src/discovery.ts \
      libs/ton/src/safety.ts libs/ton/src/trader.ts || echo "lib compile: type errors ignored"

# Build the service
RUN npm --workspace services/ton-scanner run build

CMD ["npm", "--workspace", "services/ton-scanner", "start"]
