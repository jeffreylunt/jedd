# syntax=docker/dockerfile:1
#
# Jedd V2 — a thin agent loop for the homelab.
#
# ── 🔴 WHY THIS RUNS TypeScript DIRECTLY, NOT A COMPILED dist/ ───────────────
#
# pm2 runs `node --import tsx src/main.ts` (ecosystem.config.cjs). There is no
# build script in package.json and tsconfig sets `noEmit`. Introducing a tsc
# emit step here would make the container a DIFFERENT PROGRAM from the one that
# has been running and been debugged all week — a bad trade on a cutover night.
# So the image runs the identical command on the identical sources, and `tsx`
# is therefore a RUNTIME dependency: do not `npm prune --omit=dev` below.
#
# ── 🔴 WHY node:24 AND NOT THE HOST'S node 25 ────────────────────────────────
#
# The 1218-test suite is green on node 24.12.0 (measured on this machine). 24 is
# the version with evidence behind it; the host's Homebrew 25.2.1 is pinned in
# ecosystem.config.cjs for a macOS-only reason that does not exist here (below).
#
# ── ✅ CONTAINERISING ACTUALLY REMOVES A macOS LANDMINE ──────────────────────
#
# ecosystem.config.cjs pins /opt/homebrew/bin/node because macOS "Local Network"
# privacy denies LAN-peer access PER BINARY: nvm-built node got EHOSTUNREACH on
# 192.168.1.7 while the Homebrew build succeeded, same machine, same minute.
# That is a macOS TCC control and has no analogue inside a Linux container —
# measured from a container on this host, all of 192.168.1.7:{22,7878,8080,8989,
# 9696}, 192.168.1.68:11434 and the public internet connect fine. The container
# is therefore IMMUNE to the node-version trap that silently broke every homelab
# read for days. (Control that makes this meaningful: the LAN gateway
# 192.168.1.1 is EXEMPT from that policy, so "the router answers" proves
# nothing — reaching .1.7 on five ports is the real evidence.)

FROM node:24-alpine

# `ssh` is a hard runtime dependency, not a convenience: src/hp.ts shells out to
# it via execFile for every docker_ps / hp_shell / qbit / channel_health tool.
# tini gives us a real init so SIGTERM reaches node (see the stop-signal note in
# docker-compose.yml — webhook deregistration on shutdown is load-bearing).
RUN apk add --no-cache openssh-client tini

WORKDIR /app

# Dependencies first so edits to src/ don't re-run the install layer.
# NOTE: all deps, including devDependencies — tsx is the runtime interpreter.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# ── 🔴 THE DATA DIRECTORY IS NOT A DETAIL ────────────────────────────────────
#
# Every store resolves its path as `new URL('../data/', import.meta.url)` — that
# is relative to THE SOURCE FILE, not to cwd. With main.ts at /app/src/main.ts
# this is always /app/data. Get the WORKDIR or the copy layout wrong and the app
# does not error: it silently opens a DIFFERENT, EMPTY data dir, and an empty
# seen.jsonl means the BlueBubbles replay watermark is 0, which receiver.ts
# fails CLOSED on — it skips replay entirely and every message that arrived
# during the gap is dropped, with no error anywhere. Always bind-mount the real
# data dir over this one.
RUN mkdir -p /app/data

# ── The container runs as uid 501 (jeff), NOT the image's `node` user ────────
#
# Two reasons, both concrete:
#  1. The SSH private keys are bind-mounted from the host at mode 0600 owned by
#     501:20. A process running as uid 1000 simply cannot read them, and ssh
#     would fail with "Permission denied (publickey)" that looks like a key
#     problem rather than a uid problem.
#  2. The app writes to the host's real data/ through a bind mount. Running as
#     501 means every file it creates keeps the same ownership pm2 gave it, so
#     rolling BACK to pm2 needs no chown and leaves no ownership drift.
# uid 501 is not in /etc/passwd, so HOME must be set explicitly or ssh will not
# find ~/.ssh/config and the `hp` / `hp-jedd-shell` aliases will not resolve.
# 🔴 uid 501 needs a REAL /etc/passwd ENTRY, not just $HOME.
#
# Setting HOME alone is not enough: OpenSSH calls getpwuid() and refuses to run
# at all for an unknown uid, failing with "No user exists for uid 501" before it
# ever looks at a key or a host. That would take out every hp-backed tool
# (docker_ps, hp_shell, channel_health, qbit, stuck_downloads) while the rest of
# the bot looked perfectly healthy — the kind of partial outage that reads as a
# homelab problem rather than a container problem. Measured, not guessed: the
# first preflight run of this image hit exactly that error.
#
# The primary group here is incidental — compose runs the container as 501:20 so
# the effective gid is the host's `staff`, which is what the bind-mounted data/
# and the 0600 keys actually need.
ENV HOME=/home/jedd
RUN adduser -D -u 501 -h /home/jedd -s /bin/sh jedd \
    && mkdir -p /home/jedd/.ssh /home/jedd/.superbot2/backups \
    && chown -R 501:20 /home/jedd /app/data \
    && chmod 700 /home/jedd/.ssh
USER 501:20

# The BlueBubbles webhook receiver. Keep this in step with
# BLUEBUBBLES_WEBHOOK_PORT — and see the compose file for why the port number
# must not drift.
EXPOSE 18796

# ── Healthcheck: GET, deliberately ───────────────────────────────────────────
#
# There is no /health route; receiver.ts answers 404 to anything that is not a
# POST to the webhook path. A 404 is therefore a perfectly good liveness signal —
# it proves the HTTP server is up and routing. We must NOT healthcheck with a
# POST to /webhook: that path feeds straight into ingest() and would inject a
# synthetic payload into the real message pipeline every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.BLUEBUBBLES_WEBHOOK_PORT||18796)+'/healthz',r=>process.exit(r.statusCode===404?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
