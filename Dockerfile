ARG ARCH=

FROM ${ARCH}node:22.14.0-bookworm AS build
WORKDIR /app/
COPY package.json package-lock.json tsup.config.ts tsconfig.json ./
RUN npm install --include=dev
COPY src src
RUN npx tsup

FROM ${ARCH}node:22.14.0-bookworm-slim
WORKDIR /app/
COPY --from=build /app/dist/app.js /app/app.js
EXPOSE 3000
CMD [ "node", "/app/app.js" ]
