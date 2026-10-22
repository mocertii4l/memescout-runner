FROM node:22-alpine
WORKDIR /app
COPY launch-listener.mjs fast-monitor.mjs start.mjs ./
USER node
CMD ["node", "start.mjs"]
