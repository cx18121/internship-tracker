# syntax=docker/dockerfile:1
# Playwright's official image — has Firefox + Chromium + system deps preinstalled.
# Node 22 is bundled. Tagged to match our playwright npm dep.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Python is needed by the JobSpy poller (scripts/jobspy_runner.py).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Python venv for JobSpy
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir --upgrade pip \
 && .venv/bin/pip install --no-cache-dir python-jobspy

# Source
COPY . .

# Build Next.js
RUN npm run build

# Move the in-source data/ aside as a default seed. At container start the
# entrypoint will copy any missing files into /app/data — which is where the
# Railway persistent volume mounts.
RUN mv data data-defaults && mkdir -p data

# Entrypoint seeds /app/data from defaults on first boot, then hands off
# to the supervisor that runs the Next.js server + the polling loop.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "serve"]
