# syntax=docker/dockerfile:1
#
# Runner image for RunnerJob containers (deployer and root runner). PID 1 idles for at most two
# hours; each job is one `exec` of the agent. Every input is pinned:
#
# - BASE_IMAGE: a Node 24 Debian slim image pinned by digest. The default below is deliberately not
#   a valid reference, so the build fails until commissioning supplies a reviewed digest.
# - Tool versions are pinned here; their SHA-256 values have NO defaults. Each must be copied from
#   the vendor's signed checksum file at commissioning and reviewed. A missing value fails the build.
#
# Wrangler builds this file for the `runner` image (wrangler.jsonc, wrangler.root-runner.jsonc), so
# once reviewed, the digests and checksums are committed here as ARG defaults.

ARG BASE_IMAGE=COMMISSIONING_REQUIRED_node_24_bookworm_slim_pinned_by_sha256_digest

FROM ${BASE_IMAGE} AS tools
ARG TOFU_VERSION=1.10.6
ARG TOFU_SHA256
ARG CLOUDFLARE_PROVIDER_VERSION=5.28.0
ARG CLOUDFLARE_PROVIDER_SHA256
ARG CONFTEST_VERSION=0.71.1
ARG CONFTEST_SHA256
ARG GH_VERSION=2.74.0
ARG GH_SHA256
COPY agent/tar.mjs agent/errors.mjs /build/agent/
COPY build/fetch-verified.mjs /build/build/fetch-verified.mjs
RUN set -eu; \
    fetch="node /build/build/fetch-verified.mjs"; \
    $fetch download "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.zip" "${TOFU_SHA256}" /tmp/tofu.zip; \
    $fetch unzip /tmp/tofu.zip /tmp/tofu; \
    mkdir -p /out/bin; cp /tmp/tofu/tofu /out/bin/tofu; \
    $fetch download "https://github.com/cloudflare/terraform-provider-cloudflare/releases/download/v${CLOUDFLARE_PROVIDER_VERSION}/terraform-provider-cloudflare_${CLOUDFLARE_PROVIDER_VERSION}_linux_amd64.zip" "${CLOUDFLARE_PROVIDER_SHA256}" /tmp/provider.zip; \
    $fetch unzip /tmp/provider.zip "/out/providers/registry.opentofu.org/cloudflare/cloudflare/${CLOUDFLARE_PROVIDER_VERSION}/linux_amd64"; \
    $fetch download "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz" "${CONFTEST_SHA256}" /tmp/conftest.tar.gz; \
    $fetch untar /tmp/conftest.tar.gz conftest /out/bin/conftest; \
    $fetch download "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" "${GH_SHA256}" /tmp/gh.tar.gz; \
    $fetch untar /tmp/gh.tar.gz "gh_${GH_VERSION}_linux_amd64/bin/gh" /out/bin/gh; \
    /out/bin/tofu version | grep -qx "OpenTofu v${TOFU_VERSION}"; \
    /out/bin/conftest --version | grep -q "${CONFTEST_VERSION}"; \
    /out/bin/gh --version | grep -q "gh version ${GH_VERSION} "

FROM ${BASE_IMAGE}
RUN set -eu; \
    node --version | grep -q '^v24\.'; \
    groupadd --system --gid 10001 runner; \
    useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin runner
COPY --from=tools /out/ /opt/runner/
COPY agent/ /opt/runner/agent/
COPY tofurc /opt/runner/tofurc
# Commissioning input: trusted_root.jsonl is absent until reviewed (docs/RUNNER.md); release.verify
# fails with trusted_root_missing until then.
COPY trust/ /opt/runner/trust/
# Root owns everything under /opt/runner and nothing there is writable by the runner user; the
# only writable place a job uses is /tmp/job.
RUN chown -R root:root /opt/runner && chmod -R a+rX,go-w /opt/runner
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
USER 10001:10001
WORKDIR /tmp
# Idle PID 1 with a hard two-hour lifetime; jobs arrive through `exec`. Every job deadline leaves
# at least 20 minutes of this lifetime unused (worker/runner/limits.ts).
ENTRYPOINT ["/bin/sleep", "7200"]
