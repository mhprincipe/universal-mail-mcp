FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Where this release's server looks for newer versions (release.yml sets it;
# empty: no update notices).
ARG UPDATE_FEED_URL=
ENV UPDATE_FEED_URL=${UPDATE_FEED_URL}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/src/index.js"]
