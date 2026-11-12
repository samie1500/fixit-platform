FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY package.json ./
COPY server.js ./
COPY db.js ./
COPY public ./public

# Port configuration
ENV PORT=3000
EXPOSE 3000

# Start Fixit server
CMD ["node", "server.js"]
