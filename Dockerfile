ARG ARCH=

FROM ${ARCH}node:22.11.0-bookworm AS build
ARG GREENLOCK_EMAIL GREENLOCK_SUBJECT
WORKDIR /app/
COPY package.json package-lock.json tsup.config.ts tsconfig.json ./
RUN npm install --include=dev && \
    npx greenlock add --subject ${GREENLOCK_SUBJECT} --altnames ${GREENLOCK_SUBJECT} && \
    npx greenlock defaults --store greenlock-store-fs --store-base-path ./greenlock.d
COPY src src
RUN npx tsup

FROM ${ARCH}node:22.11.0-bookworm-slim
WORKDIR /app/
COPY --from=build /app/dist/app.js /app/app.js
COPY --from=build /app/node_modules/@greenlock/manager/ /app/node_modules/@greenlock/manager/
COPY --from=build /app/node_modules/greenlock-store-fs/ /app/node_modules/greenlock-store-fs/
COPY --from=build /app/node_modules/greenlock-manager-fs/ /app/node_modules/greenlock-manager-fs/
COPY --from=build /app/node_modules/acme-http-01-standalone/ /app/node_modules/acme-http-01-standalone/
COPY --from=build /app/node_modules/safe-replace/ /app/node_modules/safe-replace/
COPY --from=build /app/node_modules/@root/mkdirp/ /app/node_modules/@root/mkdirp/
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/greenlock.d/ /app/greenlock.d/
EXPOSE 80 443
CMD [ "node", "/app/app.js" ]
