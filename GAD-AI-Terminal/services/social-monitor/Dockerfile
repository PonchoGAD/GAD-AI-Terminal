FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/social-monitor/package.json ./services/social-monitor/package.json
COPY libs ./libs
COPY services/social-monitor ./services/social-monitor
RUN npm install
RUN npm --workspace services/social-monitor run build
CMD ["node", "services/social-monitor/dist/index.js"]
