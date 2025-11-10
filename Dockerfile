# Use a minimal official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production
RUN npm install uuid

# Copy source code
COPY . .

# Expose the port used by the app
EXPOSE 3001

# Start the application
CMD ["node", "index.js"]
