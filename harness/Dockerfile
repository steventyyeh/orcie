FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
# Headless browser for web interaction: Playwright MCP + Chromium (shared path so the non-root user can use it).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw
RUN npm install -g @playwright/mcp playwright \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/pw && rm -rf /var/lib/apt/lists/*
# claude refuses --dangerously-skip-permissions as root, so run as the built-in non-root "node" user.
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node src /app/src
COPY bin/orcie-dm /usr/local/bin/orcie-dm
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/orcie-dm /entrypoint.sh
USER node
ENV HOME=/data/home
VOLUME /data
EXPOSE 9090
ENTRYPOINT ["/entrypoint.sh"]
