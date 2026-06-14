FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/base-scanner/package.json ./services/base-scanner/package.json
COPY libs ./libs
COPY services/base-scanner ./services/base-scanner
RUN npm install
RUN npm --workspace services/base-scanner run build
CMD ["npm", "--workspace", "services/base-scanner", "start"]
