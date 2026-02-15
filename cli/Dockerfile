FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache git openssh-client ca-certificates
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN ln -s /app/dist/index.js /usr/local/bin/rag-index
RUN chown -R app:app /app
USER app
ENTRYPOINT ["node", "/app/dist/index.js"]
