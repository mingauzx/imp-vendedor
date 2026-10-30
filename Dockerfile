FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY index.ts ./
USER bun
EXPOSE 8080
CMD ["bun", "index.ts"]
