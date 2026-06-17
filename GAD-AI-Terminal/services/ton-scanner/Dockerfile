FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/ton-scanner/package.json ./services/ton-scanner/package.json
COPY libs ./libs
COPY services/ton-scanner ./services/ton-scanner
RUN npm install
RUN npm --workspace services/ton-scanner run build
CMD ["npm", "--workspace", "services/ton-scanner", "start"]
