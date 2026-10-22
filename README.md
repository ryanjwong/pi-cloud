# pi-cloud

Run [Pi](https://github.com/earendil-works/pi) agents in the cloud instead of in your terminal.

You open Pi's TUI in a checkout as usual. The agent, its model credentials and its tools run on a server, working
in a sandbox cloned from your repository's origin. Close the laptop and the session keeps going; `pi-cloud -c`
picks it up again from any machine. Sessions can also start from GitHub comments or Slack messages.

It is a single-tenant stack: one control plane that owns all state, and runners that host sessions anywhere with
outbound HTTP. It runs as one Node process, as a control plane and runners on separate machines, or entirely on
Cloudflare.

## Try it locally

Needs Node 22.19+, pnpm and git.

```sh
git clone https://github.com/ryanjwong/pi-cloud.git && cd pi-cloud
pnpm install
ANTHROPIC_API_KEY=sk-ant-... pnpm start        # control plane and runner on 127.0.0.1:8787
```

In another terminal:

```sh
alias pi-cloud="node $PWD/packages/cli/src/main.ts"
cd ~/code/some-repo
pi-cloud
```

Without an API key, sign in with a subscription instead: `pi-cloud login anthropic` (Claude Pro/Max) or
`pi-cloud login openai-codex` (ChatGPT).

The local server listens on loopback only, with no API key. The agent's sandbox there is a plain directory under
`apps/local/.data`, not isolated. To expose the server or run untrusted code, see [Deploying](docs/deploy.md).

## Deploy to Cloudflare

Needs a Cloudflare account, plus `sops` and `age` (`brew install sops age`).

```sh
pnpm deploy:cloudflare
```

It creates an age key if you have none and points `.sops.yaml` at it. It generates pi-cloud's own secrets, then
asks for your model, [Daytona](https://app.daytona.io) and GitHub keys; press Enter to skip any of them. Everything
is kept encrypted in `secrets.yaml`. Then it signs you in to Cloudflare, deploys, and prints the `export` lines that
point `pi-cloud` at the new URL. Run it again to redeploy; it only asks for keys that are missing.

Daytona provides the sandboxes, since a Worker has no shell of its own. On Cloudflare the agent gets Pi's coding
tools but not yet Pi's full coding-agent prompt or subagents. [Deploying](docs/deploy.md) has the details.

## Using it

```sh
pi-cloud                     # new session on this repository's origin, at the current branch
pi-cloud -c                  # continue this repository's latest session
pi-cloud -r ses_...          # attach to any session
pi-cloud ls                  # list sessions
pi-cloud chat | send | tail  # line-mode chat, one-shot message, follow events
pi-cloud login <provider>    # store a subscription login on the server
```

The cloud session works from origin, so push first; the CLI warns when your branch is ahead. Point it at a server
with `PI_CLOUD_URL` and `PI_CLOUD_API_KEY`. `PI_CLOUD_SANDBOX_PROVIDER` picks the sandbox: `local`, `docker` or
`daytona`.

## Docs

- [Deploying](docs/deploy.md): local, split across machines, NixOS, Cloudflare, backups
- [Secrets and security](docs/secrets.md): SOPS, what each secret guards, subscription logins
- [GitHub and Slack](docs/integrations.md): triggers, the GitHub App, writing your own
- [Architecture](docs/architecture.md): how a session runs, leases, replicas, the packages
- [Extending](docs/extending.md): runner plugins, sandbox providers, storage, the APIs
- [Testing](docs/testing.md): what the property tests check

## Status

Works end to end in tests (`pnpm test`, about 150 tests), but not yet against real model providers, a real
Cloudflare account, or the live GitHub and Daytona APIs. Known gaps:

- One control-plane process at a time: leases and event streams live in its memory.
- The TUI is Pi 1.1's durable TUI, which Pi 1.3 dropped. It has no session picker, forks or `/login`.
- On Cloudflare: no Pi coding-agent prompt or subagents, and no GitHub or Slack connectors yet.
- The Nix package has a placeholder dependency hash; the first `nix build` prints the real one.
- Pi Durable is experimental; versions are pinned.
