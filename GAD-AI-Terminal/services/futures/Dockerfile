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

# Compile TypeScript
RUN cd services/futures && npx tsc --project tsconfig.json --skipLibCheck || true

# Runtime: compiled JS, node resolves @lib/db via root node_modules/@lib/db symlink
CMD ["node", "services/futures/dist/index.js"]
