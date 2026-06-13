FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/telegram/package.json ./services/telegram/package.json
COPY libs ./libs
COPY services/telegram ./services/telegram
RUN npm install
RUN npx tsc -p libs/lifecycle/tsconfig.build.json
RUN npx tsc -p libs/regime/tsconfig.build.json
RUN npx tsc -p libs/reputation/tsconfig.build.json
RUN npx tsc -p libs/memory/tsconfig.build.json
RUN npx tsc -p libs/opportunity/tsconfig.build.json
RUN npx tsc -p libs/trend-engine/tsconfig.build.json || echo "trend-engine build skipped (non-critical)"
RUN npm --workspace services/telegram run build
CMD ["npm", "--workspace", "services/telegram", "start"]
