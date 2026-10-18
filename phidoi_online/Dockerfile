FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8090 DATA_DIR=/data
VOLUME /data
EXPOSE 8090
CMD ["node", "server/main.js"]
