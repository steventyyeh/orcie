FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates procps xvfb x11vnc xdotool imagemagick \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
# Headless browser for web interaction: Playwright MCP + Chromium (shared path so the non-root user can use it).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw
RUN npm install -g @playwright/mcp playwright \
    && playwright install --with-deps chromium \
    && ln -s /opt/pw/chromium-*/chrome-linux*/chrome /usr/local/bin/orcie-chromium \
    && chmod -R a+rX /opt/pw && rm -rf /var/lib/apt/lists/*
# GitHub CLI + git config: HTTPS auth through the shared, mounted token (no secrets in the image).
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
# Libraries and Chinese fonts that desktop apps (WeChat) need on the virtual display. The apps themselves are NOT in the image: an agent installs one into its own volume (wechat-app install).
RUN apt-get update && apt-get install -y --no-install-recommends openbox tint2 xterm x11-xserver-utils unzip fonts-noto-cjk dbus-x11 libatomic1 libgtk-3-0 libegl1 libgl1 libgbm1 libnss3 libxkbcommon-x11-0 libasound2 libwayland-client0 libxcomposite1 libxdamage1 libxrandr2 libpulse0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxcb-xinerama0 libxcb-xkb1 libxss1 libxtst6 libdrm2 \
    && rm -rf /var/lib/apt/lists/*
# claude refuses --dangerously-skip-permissions as root, so run as the built-in non-root "node" user.
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node src /app/src
COPY bin/orcie-dm /usr/local/bin/orcie-dm
COPY bin/orcie-tool /usr/local/bin/orcie-tool
COPY bin/orcie-vncpipe /usr/local/bin/orcie-vncpipe
COPY bin/wechat-app /usr/local/bin/wechat-app
COPY bin/line-app /usr/local/bin/line-app
COPY bin/desktop-app /usr/local/bin/desktop-app
COPY bin/git-credential-orcie /usr/local/bin/git-credential-orcie
COPY bin/gh-wrapper /usr/local/bin/gh
COPY entrypoint.sh /entrypoint.sh
RUN ln -s /usr/local/bin/orcie-tool /usr/local/bin/remember && ln -s /usr/local/bin/orcie-tool /usr/local/bin/recall && ln -s /usr/local/bin/orcie-tool /usr/local/bin/read_room && ln -s /usr/local/bin/orcie-tool /usr/local/bin/send_message && ln -s /usr/local/bin/orcie-tool /usr/local/bin/browser_help && ln -s /usr/local/bin/orcie-tool /usr/local/bin/promise && ln -s /usr/local/bin/orcie-tool /usr/local/bin/share_file && ln -s /usr/local/bin/orcie-tool /usr/local/bin/fetch_file && ln -s /usr/local/bin/orcie-tool /usr/local/bin/hire && ln -s /usr/local/bin/orcie-tool /usr/local/bin/remind_me && ln -s /usr/local/bin/orcie-tool /usr/local/bin/list_reminders && ln -s /usr/local/bin/orcie-tool /usr/local/bin/cancel_reminder \
 && chmod +x /usr/local/bin/orcie-tool /usr/local/bin/orcie-vncpipe /usr/local/bin/wechat-app /usr/local/bin/line-app /usr/local/bin/desktop-app /usr/local/bin/orcie-dm /usr/local/bin/git-credential-orcie /usr/local/bin/gh /entrypoint.sh \
    && git config --system credential.helper orcie \
    && git config --system url."https://github.com/".insteadOf git@github.com: \
    && git config --system --add url."https://github.com/".insteadOf ssh://git@github.com/
USER node
ENV HOME=/data/home
VOLUME /data
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -sf localhost:9090/healthz || exit 1
ENTRYPOINT ["/entrypoint.sh"]
