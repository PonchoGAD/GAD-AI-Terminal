FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/bsc-scanner/package.json ./services/bsc-scanner/package.json
COPY libs ./libs
COPY services/bsc-scanner ./services/bsc-scanner
RUN npm install
RUN npm --workspace services/bsc-scanner run build
CMD ["npm", "--workspace", "services/bsc-scanner", "start"]
