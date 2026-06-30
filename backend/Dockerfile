FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
EXPOSE 3001
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
