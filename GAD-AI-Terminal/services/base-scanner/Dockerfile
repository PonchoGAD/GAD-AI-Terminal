FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /usr/src/app
COPY package.json ./
COPY tsconfig.base.json ./
COPY services/base-scanner/package.json ./services/base-scanner/package.json
# Remove github-sourced pumpdotfun-sdk — base-scanner doesn't use it and its prepare script fails
RUN node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); delete (p.dependencies||{})['pumpdotfun-sdk']; require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
COPY libs ./libs
COPY services/base-scanner ./services/base-scanner
RUN npm install
RUN npm --workspace services/base-scanner run build
CMD ["npm", "--workspace", "services/base-scanner", "start"]
