# GitHub and Slack

Two kinds of connector start sessions from outside:

- A **trigger** is one-way. A webhook comes in and becomes a prompt for the session that belongs to its subject,
  say `github:acme/api#42`. The session is created the first time and woken after that. To respond, the agent
  uses tools, such as commenting on the pull request. Triggers are mounted at `POST /v1/triggers/{name}`.
- A **source** is two-way. Incoming messages become prompts, and the agent's replies are posted back where the
  conversation is, such as the Slack thread. Sources are mounted at `POST /v1/sources/{name}`.

Each external subject is bound to one session. Redelivered webhooks are ignored, and each reply is posted once,
across restarts too.

These connectors run on the Node servers. Cloudflare doesn't have them yet.

## GitHub

Set `GITHUB_WEBHOOK_SECRET` (the trigger refuses to start without one). Only authors whose association is in
`GITHUB_ALLOWED_ASSOCIATIONS` (default `OWNER,MEMBER,COLLABORATOR`) start or wake a session, on every action;
`GITHUB_MENTION=@pi` also requires that whole word in the text. Issues, comments, pull requests and reviews each go to
the session for their thread, and replayed bodies are dropped whatever their delivery id. That session works in the
`github` template (provider `GITHUB_SANDBOX_PROVIDER`, default `docker`) cloned from the repository; pull requests
from forks get no template secrets. The agent has two tools, bound to that repository: `github_comment` (which
defaults to the thread) and `github_open_pull_request`. Those tools run on the runner, so their token never enters
the sandbox. Git in the sandbox gets the token through a credential helper, never through a URL or `.git/config`.

### GitHub App

An App beats a personal token. Each session gets a token that only covers its own repository and expires after an
hour, the App's private key never leaves the control plane, and the agent posts as `your-app[bot]`.

```sh
pi-cloud github-app --url https://pi.example.com --org acme
```

Run `pi-cloud init` first. It opens GitHub with the App filled in: private; contents, issues and
pull requests set to write; the trigger's events; and the webhook at `<url>/v1/triggers/github`. You click Create.
GitHub sends you back to the command, which stores `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
`GITHUB_WEBHOOK_SECRET` in `~/.config/pi-cloud/secrets.yaml` (or `--secrets <file>`). Then install the App on
your repositories from the link it prints and restart the control plane.

- `--manifest` prints the manifest, to create the App by hand.
- `--print` prints the credentials instead of storing them.
- Without a public `--url`, the App gets no webhook: it provides tokens, but GitHub events won't reach pi-cloud.

A session's token covers the one repository the server bound to it: the trigger's, or the GitHub repository its
sandbox resolved to from an operator template. A session with none gets no token. Runners fetch it from the control
plane and refresh it before it expires, so long sessions can keep pushing.

Without an App, the runner's own `GITHUB_TOKEN` is used, and only if it is listed in `SANDBOX_SECRETS`: both
sandboxes and the GitHub tools read it from there.

## Slack

Set `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`, and point the Slack app's event subscription at
`/v1/sources/slack`. Each thread is a session: mention the bot to start one, and reply in the thread to continue.
Nobody is answered until you list user ids in `SLACK_ALLOWED_USERS` or channel ids in `SLACK_ALLOWED_CHANNELS`.

## Writing a connector

A `Trigger` is a name and `handle(request)`, which returns the events. A `Source` adds `deliver(target, reply)`.
`@pi-cloud/triggers` has a generic signed-JSON webhook (its secret is required) to copy from, and `hmacSha256Hex` and `verifyHmac` for
signatures. They use Web Crypto, so connectors run on any runtime. Mount them with `triggers([...])` or
`sources([...])` in the control plane's `extensions`; see `apps/local/src/connectors.ts`.
