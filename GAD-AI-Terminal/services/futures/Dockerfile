FROM node:20-alpine

WORKDIR /app

# Only install what futures actually needs:
# - pg (via @lib/db)
# - axios, express (service deps)
# - ts-node, tsconfig-paths, typescript (TS runtime)
RUN npm install --no-save pg dotenv axios express \
    ts-node tsconfig-paths typescript \
    @types/node @types/express 2>/dev/null

# Copy base TypeScript config
COPY tsconfig.base.json ./

# Copy @lib/db (pre-compiled JS, only dep from libs/)
COPY libs/db ./libs/db

# Copy futures service source
COPY services/futures ./services/futures

# Create tsconfig.json at root for tsconfig-paths to find
RUN cp tsconfig.base.json tsconfig.json

ENV TS_NODE_PROJECT=/app/services/futures/tsconfig.json

CMD ["node", "-r", "ts-node/register", "-r", "tsconfig-paths/register", "services/futures/src/index.ts"]
