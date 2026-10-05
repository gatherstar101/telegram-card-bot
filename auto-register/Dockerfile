FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY api ./api
COPY scripts/assign-account.js ./scripts/assign-account.js
COPY scripts/migrate.js ./scripts/migrate.js
COPY scripts/backfill-phones.js ./scripts/backfill-phones.js
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=3100 DATA_DIR=/data
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/server.js"]
