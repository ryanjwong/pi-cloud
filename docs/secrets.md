# Secrets and security

## Where secrets live

All secrets live in one file, `secrets.yaml`, encrypted with [SOPS](https://github.com/getsops/sops) and age. Key
names stay readable and values don't, so the file can be committed. `.sops.yaml` lists who can decrypt it: your
age key, and each server's.

`pnpm deploy:cloudflare` sets this up for you. By hand: create an age key, put the public key it prints in
`.sops.yaml`, then encrypt the example file and edit it with `sops`.

```sh
age-keygen -o ~/.config/sops/age/keys.txt
cp secrets.example.yaml secrets.yaml
sops encrypt --in-place secrets.yaml
sops secrets.yaml
```

Every server reads settings through the same typed schema (`@pi-cloud/config`). A missing or malformed value
stops startup with a message naming it. How the values arrive:

| Where | How |
|---|---|
| Your machine | `sops exec-env secrets.yaml '<command>'` decrypts into that one process's environment |
| NixOS | sops-nix files, passed to the service with systemd `LoadCredential` |
| Containers | one file per setting in a directory named by `PI_CLOUD_SECRETS_DIR` |
| Cloudflare | Worker secrets, set by `pnpm deploy:cloudflare` |

Don't put secrets in `.env` or `.dev.vars`.

## What guards what

| | Needs | Without it |
|---|---|---|
| Public API: REST, `/v1/pi`, the session channel | `PI_CLOUD_API_KEYS`, sent as `Authorization: Bearer` | open on 127.0.0.1; anywhere else the server won't start |
| Runner RPC: session state and stored credentials | `PI_CLOUD_RUNNER_SECRET` on every call | the one-process server makes a random one per start; split servers and Cloudflare won't start |
| A runner's wake endpoint | the runner secret, and a fixed `CONTROL_PLANE_URL` | rejects every wake |
| Stored model logins | `PI_CLOUD_CREDENTIAL_KEY` (AES-256-GCM) | stored as plain JSON on 127.0.0.1; anywhere else the server won't start |

API keys are only accepted in the `Authorization` header, never in a URL, because proxies and logs keep URLs.
Browsers can't set that header on a WebSocket, so a browser UI has to sit behind a same-origin proxy that adds
it. On Cloudflare the runner RPC isn't routed at all: the Worker forwards only public paths, and session objects
call the control plane object directly.

## What the agent can see

The agent runs commands in a sandbox, and the text it reads (GitHub comments, Slack messages) is written by other
people, so assume it can be talked into printing whatever its sandbox holds.

- A sandbox gets only the secrets its template names, and only names listed in `SANDBOX_SECRETS`. Model keys and
  the runner secret never reach a sandbox.
- Secret values that do reach a sandbox are replaced with `[secret:NAME]` in command output and tool results
  before anything is stored or streamed.
- Model keys and stored logins are used by the runner, outside the sandbox.
- With a [GitHub App](integrations.md#github-app), a sandbox's `GITHUB_TOKEN` is limited to the session's own
  repository and expires after an hour.

## Subscription logins

Instead of API keys, sessions can use a ChatGPT Plus/Pro, Claude Pro/Max or GitHub Copilot login. You sign in once
from your machine with Pi's own login flow, and the tokens are stored, encrypted, on the control plane. Every runner
uses them and refreshes them when they expire.

| Command | |
|---|---|
| `pi-cloud login openai-codex` | ChatGPT, in the browser |
| `pi-cloud login anthropic` | Claude Pro/Max |
| `pi-cloud login --from-codex` | reuse the login of `codex login` |
| `pi-cloud login --from-pi anthropic` | reuse a login made with Pi |
| `pi-cloud auth` | list what is stored |
| `pi-cloud logout anthropic` | remove a login |

Check your provider's terms first; Anthropic, for one, restricts using Claude Pro/Max logins outside its own apps.
An imported login is shared with the tool it came from: when one side refreshes the token, the other may be signed
out. `pi-cloud login` creates a separate login.
