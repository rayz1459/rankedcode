# Node 20 on Debian Bookworm (has apt for Java + build deps for native modules)
FROM node:20-bookworm

# Install OpenJDK 17 so Run/Test/Submit work for Java in the code editor
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (npm ci for reproducible installs)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application
COPY server ./server
COPY public ./public

# Render sets PORT; app uses process.env.PORT
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
