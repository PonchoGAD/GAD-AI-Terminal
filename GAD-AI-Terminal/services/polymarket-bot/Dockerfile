FROM node:20-slim
WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY libs ./libs
COPY services/polymarket-bot ./services/polymarket-bot

RUN npm install --legacy-peer-deps

ENV TS_NODE_PROJECT=/usr/src/app/services/polymarket-bot/tsconfig.json
ENV TS_NODE_TRANSPILE_ONLY=true

CMD ["node", "-r", "ts-node/register", "-r", "tsconfig-paths/register", "services/polymarket-bot/src/index.ts"]
