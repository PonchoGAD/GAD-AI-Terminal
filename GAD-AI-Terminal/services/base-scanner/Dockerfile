FROM node:20-alpine

WORKDIR /app

# Root workspace files
COPY package.json package-lock.json ./

# Libs
COPY libs/db        ./libs/db
COPY libs/base      ./libs/base

# Service
COPY services/base-scanner ./services/base-scanner

RUN npm install --workspace=@service/base-scanner --workspace=@lib/db --workspace=@lib/base --include-workspace-root

WORKDIR /app/services/base-scanner
RUN npm run build

CMD ["node", "dist/index.js"]
