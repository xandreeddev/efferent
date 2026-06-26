# Isolated end-to-end test of the `efferent` npm package (the packed tarball).
#
# Installs the bundle into a clean image exactly as a user would, then runs
# run.sh: install/boot checks, no-key graceful degradation, and — when a provider
# auth.json is mounted at run time — a real one-shot turn through BOTH the
# in-process and split-daemon paths.
#
# A provider key is NEVER baked in: mount it read-only at run time.
#
# Build context is test/docker/ (the tarball is staged here by test.sh):
#   docker build --build-arg TARBALL=efferent-0.2.0.tgz -t efferent-e2e test/docker
# Run (keyed):
#   docker run --rm -v "$HOME/.efferent/auth.json:/root/.efferent/auth.json:ro" efferent-e2e
FROM node:24-slim

# Bun is efferent's runtime (the bin shebang is `#!/usr/bin/env bun`); curl drives
# the daemon's HTTP API in the split-daemon test.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g bun

# Install efferent exactly as a user would, from the packed tarball.
ARG TARBALL
COPY ${TARBALL} /tmp/efferent.tgz
RUN npm i -g /tmp/efferent.tgz

# A scratch workspace to run agents in.
RUN mkdir -p /work && printf '# scratch workspace\n' > /work/README.md
WORKDIR /work

COPY run.sh /usr/local/bin/run-efferent-test
RUN chmod +x /usr/local/bin/run-efferent-test
ENTRYPOINT ["/usr/local/bin/run-efferent-test"]
