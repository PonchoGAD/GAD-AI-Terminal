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

# Install all workspace deps (creates node_modules/@lib/* symlinks via npm workspaces)
RUN npm install --ignore-scripts

# TS_NODE_PROJECT tells ts-node + tsconfig-paths which config to use
ENV TS_NODE_PROJECT=/usr/src/app/services/futures/tsconfig.json

# Run directly via ts-node (development-grade but avoids slow compile step)
CMD ["node", "-r", "ts-node/register", "-r", "tsconfig-paths/register", "services/futures/src/index.ts"]
