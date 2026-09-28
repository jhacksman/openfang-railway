# OpenFang on Railway: pinned upstream release binary + readiness gate.
# Upstream: https://github.com/RightNow-AI/openfang (Apache-2.0 OR MIT)
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG OPENFANG_VERSION=0.6.9
ARG OPENFANG_SHA256=4309b0bcf2adc5dac45776e2008087a8ad072933f1ae698ff8d4e06fb6b87602
ARG TEMPLATE_VERSION=dev

# Same runtime dependencies as upstream's Dockerfile (python + node for skills
# and MCP servers) plus ca-certificates, tini (PID 1) and gosu (drop root).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gosu python3 python3-pip python3-venv tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 openfang \
 && useradd --uid 10001 --gid openfang --home-dir /data --no-create-home --shell /usr/sbin/nologin openfang

RUN set -eu; \
    url="https://github.com/RightNow-AI/openfang/releases/download/v${OPENFANG_VERSION}/openfang-x86_64-unknown-linux-gnu.tar.gz"; \
    curl -fsSL -o /tmp/openfang.tar.gz "$url"; \
    echo "${OPENFANG_SHA256}  /tmp/openfang.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/openfang.tar.gz -C /usr/local/bin openfang; \
    chmod 0755 /usr/local/bin/openfang; \
    rm -f /tmp/openfang.tar.gz; \
    /usr/local/bin/openfang --version

WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md package.json ./
COPY gate ./gate
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh && node --check gate/server.js

ENV OPENFANG_HOME=/data \
    OPENFANG_VERSION=${OPENFANG_VERSION} \
    TEMPLATE_VERSION=${TEMPLATE_VERSION} \
    NODE_ENV=production \
    PORT=8080

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
