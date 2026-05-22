# syntax=docker/dockerfile:1
# Slim Node base + Firefox only. Handshake's auth flow specifically needs
# Firefox to evade Cornell SSO + Handshake's headless-Chrome bot detection
# (see feedback memory), so we standardize the other Playwright pollers on
# Firefox too rather than ship two browsers. Dropping Chromium saves another
# ~250MB image size + cold-start time on top of the WebKit-drop from the
# previous commit.
FROM node:22-slim

# Python (for JobSpy) + curl/ca-certs (for `playwright install` to download
# browser binaries). Cleaned up after install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Firefox binary + its system libs. `--with-deps` installs the apt packages
# (nss, fonts, etc.) the browser needs. Browser version is pinned by the
# `playwright` npm package version, so this stays in sync with the SDK.
RUN npx playwright install --with-deps firefox \
 && rm -rf /var/lib/apt/lists/* /root/.cache/ms-playwright-cli

# Python venv for JobSpy.
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir --upgrade pip \
 && .venv/bin/pip install --no-cache-dir python-jobspy

COPY . .
RUN npm run build

# Move the in-source data/ aside as a default seed. At container start the
# entrypoint copies any missing files into /app/data — which is where the
# Railway persistent volume mounts.
RUN mv data data-defaults && mkdir -p data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "serve"]
