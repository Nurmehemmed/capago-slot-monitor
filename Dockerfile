FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production and dev dependencies for building
RUN npm ci

# Copy application source code
COPY . .

# Build TypeScript to dist
RUN npm run build

# Set production environment
ENV NODE_ENV=production
ENV HEADLESS=true

# Ensure persistent directories exist
RUN mkdir -p /app/storage /app/screenshots

# Expose health-check port for cloud hosting
EXPOSE 8080

# Start monitor & bot
CMD ["npm", "start"]
