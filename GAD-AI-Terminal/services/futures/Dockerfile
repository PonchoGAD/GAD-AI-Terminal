FROM node:20-alpine

WORKDIR /usr/src/app

# Copy workspace manifests
COPY package.json ./
COPY tsconfig.base.json ./

# Copy service manifest for workspace resolution
COPY services/futures/package.json ./services/futures/package.json

# Copy lib sources
COPY libs ./libs

# Copy service source
COPY services/futures ./services/futures

# Install all workspace deps (includes pg via @lib/db)
RUN npm install --ignore-scripts

CMD ["node", "-r", "ts-node/register", "-r", "tsconfig-paths/register", "services/futures/src/index.ts"]
