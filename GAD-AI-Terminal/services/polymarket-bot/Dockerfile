FROM node:20-slim
WORKDIR /usr/src/app

# Copy workspace files
COPY package.json package-lock.json* ./
COPY libs/db/package.json ./libs/db/
COPY services/polymarket-bot/package.json ./services/polymarket-bot/

# Install dependencies
RUN npm install --workspace=libs/db --workspace=services/polymarket-bot --legacy-peer-deps

# Copy source
COPY libs/db/src ./libs/db/src
COPY services/polymarket-bot/src ./services/polymarket-bot/src
COPY services/polymarket-bot/tsconfig.json ./services/polymarket-bot/

# Build
RUN cd services/polymarket-bot && npx tsc -p tsconfig.json

CMD ["node", "services/polymarket-bot/dist/index.js"]
