FROM node:20-alpine

WORKDIR /app

# Copy workspace config
COPY package.json ./
COPY package-lock.json ./

# Copy lib dependencies
COPY libs/db ./libs/db
COPY libs/solana ./libs/solana

# Copy service
COPY services/futures ./services/futures

# Install (skip optional Drift SDK by default — only needed for live mode)
RUN npm install --workspace=@service/futures --ignore-scripts 2>/dev/null || \
    npm install --prefix services/futures --ignore-scripts

WORKDIR /app/services/futures

CMD ["node", "-r", "tsconfig-paths/register", "-r", "ts-node/register", "src/index.ts"]
