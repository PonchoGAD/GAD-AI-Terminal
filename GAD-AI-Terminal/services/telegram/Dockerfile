FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/telegram/package.json ./services/telegram/package.json
COPY libs ./libs
COPY services/telegram ./services/telegram
RUN npm install --ignore-scripts && npm install --no-save tsconfig-paths
ENV TS_NODE_PROJECT=/usr/src/app/services/telegram/tsconfig.json
ENV TS_NODE_TRANSPILE_ONLY=true
CMD ["node", "-r", "ts-node/register", "-r", "tsconfig-paths/register", "services/telegram/src/index.ts"]
