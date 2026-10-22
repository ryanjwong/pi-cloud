# Security

pi-cloud runs an agent that executes commands, and much of what it reads (issues, comments, Slack messages, the
code it checks out) is written by other people. Treat the agent as something that can be talked into anything its
sandbox and tools allow. The defaults are built around that: sandboxes come only from the operator, the server
checks every session spec, and triggers ignore people who aren't trusted.

## Server config

One file holds the server's policy. Point `PI_CLOUD_CONFIG` at `pi-cloud.config.json` or `pi-cloud.config.ts`
(default export, typed with `defineConfig` from `@pi-cloud/config`), or set it to the JSON itself. On Cloudflare
only inline JSON works: `wrangler secret put PI_CLOUD_CONFIG`. Environment variables override the file. A bad file
stops the server at startup with the path of the bad field, such as `["sandbox"]["templates"]["api"]["provider"]`,
and so does a `sandbox.default` or `triggers.github.template` that names no template.

```json
{
  "models": { "default": "anthropic/claude-opus-5-5" },
  "providers": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "sandbox": {
    "default": "scratch",
    "templates": {
      "api": { "provider": "docker", "user": "1000:1000", "repositories": ["acme/api"], "allowRef": true, "credential": "GITHUB_TOKEN" }
    }
  },
  "triggers": {
    "github": { "allowedAssociations": ["OWNER", "MEMBER"], "mention": "@pi" },
    "slack": { "allowedUsers": ["U012AB3CD"], "allowedChannels": [] }
  },
  "unsafeLocalSandbox": false
}
```

`GET /v1/server` reports only the pi-cloud version and the services path without authentication.
`GET /v1/server/details` adds the default model and sandbox and the template names, and needs an API key.

## Sandboxes

- The built-in `scratch` template is a Docker container running as user `1000:1000`. GitHub sessions use the
  `github` template, which is the same plus the `GITHUB_TOKEN` credential.
- The `local` provider runs commands on the host with no isolation. It exists only when
  `PI_CLOUD_UNSAFE_LOCAL_SANDBOX=1` (or `unsafeLocalSandbox`) is set, which also makes it the `scratch` template, and
  the runner warns when it is.
- Docker containers run with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512` and a 4 GB
  memory limit by default. Templates may only set `memory`, `cpus` and a `network` from the provider's list
  (`bridge` and `none` by default); `host` and `container:*` are never allowed. Pin images by digest
  (`image@sha256:...`) to avoid surprises.
- The root filesystem is writable, because agents install packages. Containers are not `--read-only`.
- The docker CLI gets a fixed environment (`PATH`, `HOME` and the operator's `DOCKER_HOST`, `DOCKER_CONTEXT`,
  `DOCKER_CONFIG`). Sandbox variables go through an `--env-file` written with mode 0600 and deleted right after,
  so they never reach the CLI's own environment or the process list. This needs Docker 20.10 or newer.
- Git's credential helper answers only for `https://github.com`.

## Session specs

A spec can only narrow an operator template. `spec.sandboxes.<name>` accepts `template`, `repository` (if the
template lists it in `repositories`), `ref` (if the template sets `allowRef`), a relative `cwd` and extra `setup`.
The control plane checks this when it creates a session, whether the spec comes over REST, Chord, a trigger or a
source, and refuses with `400 SpecRejected` naming the field: for example `sandboxes.box.provider`,
`sandboxes.box.options`, `sandboxes.box.env`, `plugins` or `metadata.github`. It then stores the resolved
templates on the session, where clients can't write, and the runner uses only that copy.

Sessions stored before these checks have no resolved templates. They are still listed, but refuse every command.

## Repository binding

Only the server binds a session to a repository: the GitHub trigger binds its repository and thread, and otherwise
the session is bound to the GitHub repository its sandbox resolved to from an allowed template. The GitHub App mints
tokens for that repository only, and the GitHub tools refuse any other (`403`). The tools have no fallback token and
read `GITHUB_TOKEN` only through the session's secrets.

## Triggers and sources

- The GitHub trigger and the generic webhook refuse to start without a secret.
- GitHub events count only when the author's association is in the allowed list, on every action. With a mention
  configured, the text must also contain it as a whole word; pushes to a pull request count only if its title or
  description does.
- Replays are dropped by the SHA-256 of the body, so a new delivery id doesn't start a second run.
- Pull requests from forks get no template secrets. Comments on a fork's pull request can't be told apart, so keep
  the allowed associations tight.
- Slack answers nobody until `SLACK_ALLOWED_USERS` or `SLACK_ALLOWED_CHANNELS` lists them.

## What is not protected

- **Egress.** Sandboxes can reach the network. Any template that has secrets and takes untrusted input (GitHub,
  Slack) can leak those secrets, and the GitHub token can push to its repository. Output masking only hides values
  from transcripts. Give such templates as little as possible, and use `network: "none"` where you can.
- **The host network.** Containers can reach the Docker host. The control plane and runner bind `127.0.0.1` by
  default; keep them there, or behind authentication, when sandboxes share the host.
- **The GitHub App** asks for contents, issues and pull requests write and metadata read: the least that lets the
  agent push a branch, comment and open a pull request. Install it only on repositories you want the agent to change.
