# Hosted paper desk: Solana launch scanner + login-protected dashboard. Paper only; holds no keys.
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN rm -rf logs/data test && mkdir -p /var/data && chown node:node /var/data
USER node
ENV NODE_ENV=production DASHBOARD_HOST=0.0.0.0 DESK_LOG_DIR=/var/data/logs
EXPOSE 8080
CMD ["node", "start.mjs"]
