# The Linux release build for scripts/ci.sh --tag, with CI's packages.
FROM rust:1.99-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    libssl-dev libudev-dev libdbus-1-dev pkg-config cmake perl make \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends patchelf xdg-utils xz-utils \
 && rm -rf /var/lib/apt/lists/*
ARG NODE_VERSION=22.23.1
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1
ENV APPIMAGE_EXTRACT_AND_RUN=1 npm_config_cache=/root/.cache/npm
WORKDIR /work
