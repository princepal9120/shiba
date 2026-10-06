# Pinned to the @cloudflare/sandbox npm version in package.json (0.12.9).
# The "-opencode" variant ships the sandbox container server plus git,
# node, and miscellaneous dev tools. Harness CLIs are pinned on top so the
# exact versions are deterministic regardless of what the base image baked in.
# The @sha256 digest pins the multi-arch manifest list (amd64+arm64) fetched
# via the Docker Registry v2 manifest API — pull-by-tag retag attacks can't
# move it.
FROM docker.io/cloudflare/sandbox:0.12.9-opencode@sha256:7b84b0163bd93f090504daf2f8e33d74a219a90774802f028adbb5b9de8107b5

# One image carries every harness (opencode, Claude Code, Codex, Devin, Grok);
# a run picks one at exec time. The credential invariant is unchanged: each
# gets the dummy key, and the real credential is swapped in at the Worker's
# egress boundary. Bumping any of these versions requires re-running the T10
# live acceptance checklist — the harness event parsers couple to the formats.
# The ACP lanes (PLAN-V2-NEXT): the registry's adapters, all Apache-2.0 —
# claude-agent-acp/codex-acp are their own entrypoints; gemini-cli ships
# `--acp` natively; opencode ≥1.18.34 ships the `acp` subcommand; the Devin
# CLI ships `acp` at 3000.11.3. `command -v` probes below fail the build if
# an adapter renames its bin.
RUN npm i -g opencode-ai@1.18.34 @anthropic-ai/claude-code@2.1.277 @openai/codex@0.155.0 @xai-official/grok@1.0.41 \
    @agentclientprotocol/claude-agent-acp@0.86.0 @agentclientprotocol/codex-acp@2.1.1 @google/gemini-cli@0.62.0 \
  && opencode --version && claude --version && codex --version && grok --version && gemini --version \
  && command -v claude-agent-acp codex-acp && opencode acp --help >/dev/null \
  && gemini --help 2>&1 | grep -q -- '--acp'

# Devin CLI — checksum-verified against the published manifest
# (https://static.devin.ai/cli/current/manifest.json), version-pinned like the
# other harnesses. The tarball ships bin/devin plus man pages; only the binary
# is needed. Bump requires the same T10 pass.
# 3000.11.3 is the first registry-listed release that ships `devin acp`.
ARG DEVIN_CLI_VERSION=3000.11.3
RUN set -eux; \
  case "$(uname -m)" in \
    x86_64) t=x86_64-unknown-linux; s=83b3b113c01bf2a3e9e100db08d77e6b086806a7754f091e20831bdfe215157e;; \
    aarch64) t=aarch64-unknown-linux; s=21a2d7a8dea67987067cde7eb3fe7193a48daa8f8c3d50d414c603c4a2b67f15;; \
    *) exit 1;; \
  esac; \
  curl -sSfL -o /tmp/devin.tar.gz "https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/devin-${DEVIN_CLI_VERSION}-${t}.tar.gz"; \
  echo "${s}  /tmp/devin.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/devin.tar.gz -C /usr/local bin/devin; \
  rm /tmp/devin.tar.gz; \
  /usr/local/bin/devin --version; \
  /usr/local/bin/devin acp --help </dev/null >/dev/null 2>&1 || { echo "devin acp probe failed"; exit 1; }

# Cursor Agent CLI — checksum-verified, version-pinned like the Devin CLI.
# The tarball ships dist-package/ (the cursor-agent binary plus its native
# .node deps); the binary needs its siblings, so the whole package lands in
# /opt and only a symlink reaches PATH. Version format is Cursor's own
# date-hash release id, mirrored by harness/catalog.ts. Bump requires the
# same T10 pass.
ARG CURSOR_CLI_VERSION=2026.10.01-e373342
RUN set -eux; \
  case "$(uname -m)" in \
    x86_64) a=x64; s=a79726c6e644520e993970be4c45775a6889802b67abe461a677a53219ae28e8;; \
    aarch64) a=arm64; s=785c5f6bf2a60eb1121e27ed8c14f5ee07ed1b5b6692324f2d9a997238245eb5;; \
    *) exit 1;; \
  esac; \
  curl -sSfL -o /tmp/cursor-agent.tar.gz "https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/linux/${a}/agent-cli-package.tar.gz"; \
  echo "${s}  /tmp/cursor-agent.tar.gz" | sha256sum -c -; \
  mkdir -p /opt/cursor-agent; \
  tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent; \
  rm /tmp/cursor-agent.tar.gz; \
  chmod +x /opt/cursor-agent/dist-package/cursor-agent; \
  ln -sfn /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent; \
  /usr/local/bin/cursor-agent --version

# Antigravity ACP binary — version-pinned like the other harnesses (T50).
# Google's release archive ships `agy_acp_server.par` + its
# `localharness_external` helper; both must sit in the same directory.
# Google publishes no checksums for these archives (t3code verifies the
# byte count only), so the sha256s below were computed by downloading the
# 1.1.1 x86_64 (681,969,407 B) and arm64 (656,572,786 B) zips from
# dl.google.com on 2026-10-06 and are pinned here — the same model as the
# Devin/Cursor blocks. Recompute both on version bump.
ARG AGY_ACP_VERSION=1.1.1
RUN set -eux; \
  command -v unzip >/dev/null || (apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*); \
  case "$(uname -m)" in \
    x86_64) a=x86_64; s=38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df;; \
    aarch64) a=arm64; s=ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398;; \
    *) exit 1;; esac; \
  curl -sSfL -o /tmp/agy.zip "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_${AGY_ACP_VERSION}-linux-${a}.zip"; \
  echo "${s}  /tmp/agy.zip" | sha256sum -c -; \
  unzip -o /tmp/agy.zip -d /opt/agy; \
  rm /tmp/agy.zip; \
  chmod +x /opt/agy/agy_acp_server.par /opt/agy/localharness_external; \
  ln -sfn /opt/agy/agy_acp_server.par /usr/local/bin/agy

# Procoder commit gate — checksum-verified, version-pinned like the harnesses.
# Available to every sandboxed agent so quality-gate runs can execute
# `procoder check` inside the container. Bump requires the same T10 pass.
ARG PROCODER_VERSION=3.6.0
RUN set -eux; \
  case "$(uname -m)" in x86_64) p=linux-amd64;; aarch64) p=linux-arm64;; *) exit 1;; esac; \
  curl -sSfL -o /usr/local/bin/procoder "https://github.com/azrtydxb/procoder/releases/download/v${PROCODER_VERSION}/procoder-${p}"; \
  curl -sSfL -o /tmp/SHA256SUMS "https://github.com/azrtydxb/procoder/releases/download/v${PROCODER_VERSION}/SHA256SUMS"; \
  grep " procoder-${p}\$" /tmp/SHA256SUMS | sed "s/procoder-${p}/procoder/" > /tmp/procoder.sum; \
  cd /usr/local/bin && sha256sum -c /tmp/procoder.sum; \
  chmod +x /usr/local/bin/procoder && procoder version

EXPOSE 4096
