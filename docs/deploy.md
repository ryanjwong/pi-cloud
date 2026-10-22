# Deploying

There are three ways to run pi-cloud. All of them read settings and secrets the same way (see
[Secrets](secrets.md)).

| | Command | State |
|---|---|---|
| One process | `pnpm start` | `apps/local/.data/pi-cloud.sqlite` |
| Control plane and runners apart | `apps/local/src/control-plane.ts`, `apps/local/src/runner.ts` | the control plane's SQLite file |
| Cloudflare | `pi-cloud deploy cloudflare` | the control plane Durable Object's SQLite |

`pi-cloud-config` (or `node apps/local/src/config.ts`) lists every setting, which are set, and where each value
came from. It never prints values.

## One process

```sh
sops exec-env secrets.yaml 'pnpm start'
```

The control plane and a runner share the process but still talk over HTTP, as they would on separate machines.
The API is on port 8787 (`PORT`, `HOST`), with docs at `/docs` and the OpenAPI document at `/openapi.json`.

On `127.0.0.1` it needs no secrets. On any other `HOST` it refuses to start without `PI_CLOUD_API_KEYS` and
`PI_CLOUD_CREDENTIAL_KEY`.

## Control plane and runners on separate machines

The control plane wakes runners over HTTP, and runners connect back. Both sides share `PI_CLOUD_RUNNER_SECRET`.

On the runner machine, with `CONTROL_PLANE_URL`, `PI_CLOUD_RUNNER_SECRET` and the model keys set:

```sh
sops exec-env secrets.yaml 'node apps/local/src/runner.ts'
```

On the control plane machine, with `RUNNER_URL`, `PI_CLOUD_API_KEYS`, `PI_CLOUD_RUNNER_SECRET` and
`PI_CLOUD_CREDENTIAL_KEY` set:

```sh
sops exec-env secrets.yaml 'node apps/local/src/control-plane.ts'
```

Each refuses to start without the settings listed. A runner only ever connects to its configured
`CONTROL_PLANE_URL`, so a forged wake request cannot point it somewhere else.

## NixOS

The flake has a module. `role` is `all-in-one`, `control-plane` or `runner`. Secrets come from sops-nix and reach the service through systemd `LoadCredential`, so they
never land in the Nix store or the environment.

```nix
sops.secrets.ANTHROPIC_API_KEY.sopsFile = ./secrets.yaml;
sops.secrets.GITHUB_APP_PRIVATE_KEY.sopsFile = ./secrets.yaml;
sops.secrets.GITHUB_WEBHOOK_SECRET.sopsFile = ./secrets.yaml;

services.pi-cloud = {
  enable = true;
  role = "all-in-one";
  settings = { GITHUB_APP_ID = "123456"; GITHUB_MENTION = "@pi"; };
  sandboxTemplates.api = {
    provider = "docker";
    repository = { url = "https://github.com/acme/api.git"; };
    credential = "GITHUB_TOKEN";
    setup = [ "npm ci" ];
  };
  secrets = {
    ANTHROPIC_API_KEY = config.sops.secrets.ANTHROPIC_API_KEY.path;
    GITHUB_APP_PRIVATE_KEY = config.sops.secrets.GITHUB_APP_PRIVATE_KEY.path;
    GITHUB_WEBHOOK_SECRET = config.sops.secrets.GITHUB_WEBHOOK_SECRET.path;
  };
};
```

## Backups

On Node, everything the control plane keeps is one file, `pi-cloud.sqlite`. Runners keep nothing. Run the server
under [Litestream](https://litestream.io) to stream every change to S3, R2 or GCS, and to restore the file on a
fresh host:

```sh
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists .data/pi-cloud.sqlite
sops exec-env secrets.yaml 'litestream replicate -config litestream.yml -exec "pnpm start"'
```

`litestream.example.yml` is a starting point. On NixOS, set `services.pi-cloud.backup.{enable,url,endpoint,environmentFile}`.

## Cloudflare

```sh
pi-cloud deploy cloudflare [--name pi-cloud]
```

`nix run github:ryanjwong/pi-cloud/stable#deploy-cloudflare` does the same without installing anything. All state
lives in `$XDG_CONFIG_HOME/pi-cloud` (`~/.config/pi-cloud`), so no checkout is read or written. What it does:

1. Runs `pi-cloud init`: creates `age.key` there unless `SOPS_AGE_KEY_FILE` names one, and a `.sops.yaml` that
   encrypts to it.
2. Generates `PI_CLOUD_API_KEYS`, `PI_CLOUD_RUNNER_SECRET` and `PI_CLOUD_CREDENTIAL_KEY` if they are not in
   `secrets.yaml`.
3. Asks for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `DAYTONA_API_KEY`, without echoing them. Enter skips one.
4. Saves everything to `secrets.yaml` through `sops`.
5. Signs you in to Cloudflare if needed and runs `wrangler deploy` on the Worker that ships with the installed CLI.
6. Sends the secrets to the Worker with `wrangler secret bulk` over stdin.
7. Without a `GITHUB_APP_ID` in `secrets.yaml`, asks "Create the GitHub App now?", runs
   [`pi-cloud github-app --url <worker url>`](integrations.md#github-app), which stores the App's credentials, and sends
   them the same way. Answering no, or running off a terminal, prints that command instead; deploy again after running
   it.
8. Saves the Worker as a target named `--name` in `config.json` (mode 0600); a new target becomes the default. The CLI
   decrypts its API key from `secrets.yaml` when it needs it, so the key never sits unencrypted on disk.
   `--url` and `--api-key`, then `PI_CLOUD_URL` and `PI_CLOUD_API_KEY`, override the target.

Run it again to redeploy. To change a key, run `SOPS_AGE_KEY_FILE=~/.config/pi-cloud/age.key sops
~/.config/pi-cloud/secrets.yaml`, then deploy again. Back up the age key: without it nobody can decrypt
`secrets.yaml`. Coming from a checkout-based setup, move its `secrets.yaml`, `.sops.yaml` and your age key (as
`age.key`) into `~/.config/pi-cloud`, then deploy again.

`pi-cloud update` runs `nix profile upgrade pi-cloud` (or `git pull` and `pnpm install` in a checkout), redeploys
every saved target with the new version without asking for skipped keys, and runs `pi-cloud doctor`.

How it runs: the control plane is one Durable Object, and its SQLite is the central store. Each session's runner is
its own Durable Object, which copies the session into its own SQLite and commits through the control plane object.
A Worker in front forwards only the public API paths. Until the three pi-cloud secrets are set, every request gets
a 503.

Current limits on Cloudflare:

- Sandboxes are Daytona only (`DAYTONA_API_KEY`). Without it, the agent can only chat.
- The agent has Pi's coding tools but not Pi's coding-agent system prompt or subagents. Those read the runner's
  files, so they need a Node runner.
- GitHub works through the App only: there is no personal `GITHUB_TOKEN` on Cloudflare. The `github` template
  uses Daytona (`GITHUB_SANDBOX_PROVIDER`).
- No Slack connector yet, and no WebSocket session channel (the service API and REST work).
- Leases and event buffers live in the control plane object's memory, which lasts while anything talks to it. If
  Cloudflare evicts it, running sessions stop, and resume from their last checkpoint on the next request.
- So far this has run in a local workerd (`pnpm --filter @pi-cloud/cloudflare run dev`), not on a real account.
  The Workers free plan limits CPU time per request; if you see CPU limit errors, the paid plan lifts them.
