FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server/main.js"]
