---
title: Remote access
description: Pair your own machines with the local daemon, watch the fleet, and revoke a machine from the dashboard.
---

Remote Access lets you run approved local tasks on your own computers. You pair a machine with one command, and the dashboard lists every paired machine with its hostname, platform, detected harnesses, and status. You can revoke any machine from the same screen.

The daemon only makes outbound calls. It polls the Worker over HTTPS, so your machine needs no open port, tunnel, or VPN.

## Turn it on

Remote Access is off by default. The `/api/local/*` and `/api/computers*` routes return `404` until both of these are true:

- `SHIBA_LOCAL_RUNTIME=1` is set on the Worker.
- The `LocalDispatch` Durable Object is bound.

Pairing tokens are signed with `PAIRING_SECRET`. If that is unset, the Worker signs with `LOCAL_ADAPTER_TOKEN` instead. If neither is set, minting a pairing token returns `503`. With Remote Access off, the dashboard's Remote Access view says the local runtime is disabled.

## Pair a machine

1. In the dashboard, open **Sandbox & Safety → Remote Access** and click **Add computer**.
2. Copy the connect command. It looks like this:

   ```sh
   node scripts/shiba-local-daemon.mjs --connect https://shiba.example.com --pair <token>
   ```

3. Run it from a checkout of this repository on the machine you want to pair.

The pairing token works once and expires after 15 minutes; the modal shows a countdown. The daemon sends the token to `POST /api/local/pair`. The Worker checks the token's HMAC signature and expiry, then burns its nonce, so the same token can't be used twice. On success the Worker returns a new adapter token and a machine id, and the daemon starts polling.

If the token was expired, already used, or mistyped, the daemon exits with a message telling you to mint a new one. Mint a new token and run the command again.

## Files on the machine

The daemon keeps its state in `~/.shiba-local/`. Set `SHIBA_LOCAL_RUN_ROOT` to use a different directory.

| File | Contents | Mode |
| --- | --- | --- |
| `config.json` | `{workerUrl, adapterToken, machineId}`, written by `--connect`/`--pair` | `0600` |
| `machine-id` | A random UUID, created once and reused across restarts | `0600` |

The directory is created with mode `0700`. Pairing again overwrites `config.json` and tightens its permissions to `0600`.

The older environment-variable setup still works. If `SHIBA_WORKER_URL` and `LOCAL_ADAPTER_TOKEN` are set, they take precedence over `config.json`. In that mode the daemon authenticates with the deployment-wide bearer, not a per-machine token.

## Heartbeat and status

At startup the daemon checks which harnesses are installed by running `claude`, `codex`, `opencode`, and `agy` with `--version`. Each check has a 5-second timeout. Only the names of harnesses that respond are reported; version strings are not.

The daemon then sends a heartbeat to `POST /api/local/heartbeat` every 30 seconds. Each heartbeat includes the machine id, hostname, platform (`process.platform-process.arch`, such as `darwin-arm64`), daemon version, harness list, and the id of the run in progress, if any.

The dashboard polls `/api/computers` every 10 seconds and shows one of three statuses:

| Status | Meaning |
| --- | --- |
| `busy` | The last heartbeat reported an active run. |
| `idle` | The last heartbeat arrived within 75 seconds and reported no active run. |
| `offline` | No heartbeat for more than 75 seconds. |

Expect some lag. A machine can show `idle` or `busy` for up to about 30 seconds after the real change, plus up to 10 seconds of dashboard polling. A machine that stops reporting shows `offline` only after 75 seconds, which is two missed heartbeats plus slack.

A failed heartbeat caused by a network error is logged, and the daemon tries again on the next tick. Records for machines that have not sent a heartbeat in 7 days are deleted. A deleted machine has to be paired again.

## Revoke a machine

Click **Revoke** on a machine and confirm. This calls `POST /api/computers/revoke`, which deletes the machine record, including the stored hash of its adapter token. The machine's next heartbeat or claim then gets a `401`. The daemon logs `adapter token revoked; re-pair` and exits with code `78`, so a process supervisor can treat it as a configuration error instead of restarting it in a loop.

Things revocation does not do:

- The Worker can't cancel a run that is already in progress on the machine. The daemon only exits after its next heartbeat or claim gets a `401`, which can take up to about 30 seconds.
- It can't revoke a daemon running in environment-variable mode. That daemon uses the deployment-wide `LOCAL_ADAPTER_TOKEN`, so you have to rotate that secret to cut it off.
- It does not delete `~/.shiba-local/` on the machine. Remove the directory yourself if you are retiring the machine.

## Security model

- **The approval gate does not change.** Every local run still requires the approval card and the same approval checks as any other run. Pairing a machine only gives the daemon a way to receive work you have already approved.
- **Provider credentials never pass through the Worker.** The machine's harnesses use the credentials already on the machine. The only credential the Worker issues is the adapter token, which is a Shiba bearer token, not a provider key.
- **The Worker never stores adapter tokens in plain text.** It keeps only a SHA-256 hash, and the dashboard never shows the token. The plain token exists only in the pairing response and in the machine's `config.json`.
- **Pairing tokens are short-lived and single-use.** Each token is signed with HMAC-SHA256, expires after 15 minutes, and its nonce is deleted the first time it is used.
- **Only the dashboard can start local work.** Local runs are created from the dashboard only. The `/api/computers*` routes require dashboard sign-in, the daemon bearer only reaches `/api/local/*`, and no chat surface can reach either set of routes.

## Limits

- This is built for a single tenant. If `PAIRING_SECRET` is unset, pairing tokens are signed with the deployment's `LOCAL_ADAPTER_TOKEN`.
- Checking a daemon's token reads through the whole fleet on every daemon call. That is fine for a handful of machines and has not been measured for large fleets.
- Status lags reality by up to about 40 seconds for a change and 75 seconds for going offline. Use the run timeline, not the fleet view, to see what a task is doing.
- The connect command assumes the machine has a checkout of this repository and Node.js 22.12.0+ installed.
