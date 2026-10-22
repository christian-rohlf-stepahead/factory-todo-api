FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p /app/data && chown -R 1001:1001 /app
USER 1001
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/index.js"]
