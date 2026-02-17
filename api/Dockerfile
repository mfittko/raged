FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
