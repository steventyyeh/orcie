FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY src ./src
VOLUME /data
EXPOSE 9090
CMD ["node", "--experimental-strip-types", "src/index.ts"]
