FROM node:24-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists
ENV NODE_ENV=production \
    STRAPI_TELEMETRY_DISABLED=true \
    SHARP_IGNORE_GLOBAL_LIBVIPS=1
ARG URL

WORKDIR /opt/

COPY package.json yarn.lock ./
RUN yarn config set network-timeout 600000 -g \
    && yarn install --frozen-lockfile --production=false --non-interactive

ENV PATH=/opt/node_modules/.bin:$PATH
WORKDIR /opt/app
COPY . .
RUN yarn build

FROM build AS production-dependencies
WORKDIR /opt
RUN yarn install --frozen-lockfile --production=true --non-interactive

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists
ENV NODE_ENV=production \
    STRAPI_TELEMETRY_DISABLED=true
COPY --from=production-dependencies --chown=node:node /opt/node_modules /opt/node_modules
WORKDIR /opt/app
COPY --from=build --chown=node:node /opt/app/package.json /opt/app/tsconfig.json ./
COPY --from=build --chown=node:node /opt/app/dist ./dist
COPY --from=build --chown=node:node /opt/app/public ./public
COPY --from=build --chown=node:node /opt/app/database ./database

RUN chown node:node /opt/app
USER node
EXPOSE 1337
CMD ["yarn", "start"]
