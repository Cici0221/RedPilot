FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai DISPLAY=:99 REDPILOT_DATA_DIR=/data REDPILOT_BIND_HOST=0.0.0.0 REDPILOT_ISOLATED_BROWSER=true REDPILOT_READER_PORT=3456 REDPILOT_READER_PROXY_URL=http://127.0.0.1:3456 PORT=4317 REDPILOT_CHROME_BINARY=/usr/bin/chromium REDPILOT_PYTHON=/opt/render/bin/python
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb xauth x11vnc novnc websockify fonts-noto-cjk fonts-noto-color-emoji fontconfig poppler-utils python3 python3-venv libgl1 libegl1 libglib2.0-0 ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY requirements-render.txt ./
RUN python3 -m venv /opt/render && /opt/render/bin/pip install --no-cache-dir -r requirements-render.txt
COPY app ./app
COPY public ./public
COPY assets ./assets
COPY examples ./examples
COPY docs ./docs
COPY scripts ./scripts
COPY deploy/start.sh ./deploy/start.sh
RUN mkdir -p /data && chown node:node /data && chmod 755 /app/deploy/start.sh
USER node
EXPOSE 4317
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/start.sh"]
