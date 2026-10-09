FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/app.db PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
