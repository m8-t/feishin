# Feishin web build with the jukebox bridge patch.
# The build context is an upstream checkout at tag v${BASE_VERSION} with overlay.patch already applied
# (see .github/workflows/jukebox-image.yml).
#
# ARG BASE_VERSION: upstream version to build on (bumped nightly by jukebox-upstream-bump.yml)
# ARG BRANCH_BASE: upstream tag this branch's commits sit on (changes only on a manual rebase)

ARG BASE_VERSION=1.17.0
ARG BRANCH_BASE=1.17.0

FROM --platform=$BUILDPLATFORM node:23-alpine AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .

# Uses the version from the packageManager field of package.json
RUN corepack enable && corepack install

RUN pnpm install

COPY . .
RUN pnpm run test:jukebox && pnpm run typecheck:web && pnpm run build:web

FROM nginxinc/nginx-unprivileged:alpine-slim

LABEL org.opencontainers.image.source=https://github.com/m8-t/feishin

COPY --chown=nginx:nginx --from=builder /app/out/web /usr/share/nginx/html
COPY --chown=nginx:nginx ./settings.js.template /etc/nginx/templates/settings.js.template
COPY --chown=nginx:nginx jukebox-ng.conf.template /etc/nginx/templates/default.conf.template

ENV SERVER_LOCK=false SERVER_NAME="" SERVER_TYPE="" SERVER_URL="" REMOTE_URL=""
ENV LEGACY_AUTHENTICATION="" ANALYTICS_DISABLED="" PUBLIC_PATH="/"

EXPOSE 9180
CMD ["nginx", "-g", "daemon off;"]
