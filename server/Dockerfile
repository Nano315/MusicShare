# Image du serveur LastLink : chansons + chat (SQLite), envoyés en direct (SSE).
# Aucune dépendance : node:http + node:sqlite intégré à Node 24.

FROM node:24-bookworm-slim
WORKDIR /srv
ENV NODE_ENV=production \
    PORT=8136 \
    DB_PATH=/data/lastlink.db \
    TZ=Europe/Paris \
    NODE_NO_WARNINGS=1

COPY server.mjs migrate-firestore.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8136

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8136/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
