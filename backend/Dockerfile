# Use an official Node.js runtime as a parent image.
# We use the alpine variant for a smaller image size.
FROM node:18-alpine

# Set the working directory in the container.
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory.
# This is done as a separate step to take advantage of Docker's layer caching.
COPY package.json ./
COPY package-lock.json ./

# Install application dependencies.
# Using 'npm ci' is recommended for production as it uses the package-lock.json
# for reproducible builds.
RUN npm ci --only=production

# Copy the rest of the application's source code.
COPY . .

# The application listens on port 3000. Expose this port.
EXPOSE 3000

# Define the command to run the application.
CMD [ "node", "src/app.js" ]
