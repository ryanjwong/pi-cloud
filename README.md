# pi-cloud

A hosted control plane for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) agents.
Clients talk to one API. Each session's durable state lives in a store the control plane owns, and the agent
itself runs in a **runner** that can live anywhere with outbound HTTP: a Node process, a container, a Cloudflare
Durable Object, a Modal function. Sandboxes for the agent's tools are pluggable in the same way.

Written in TypeScript with [Effect](https://effect.website) 4. It runs on Node (one process, or a control plane
and runner hosts apart) or entirely on Cloudflare Durable Objects.

For a developer it is Pi: `pi-cloud` in a checkout opens Pi's own TUI (its editor, keybindings, theme, model
picker, `/agents`, task panel). Everything else runs in the cloud: the agent, its model credentials, and its tools,
which work in a cloud clone of the checkout's origin at the current branch. The TUI is only a projection of the
public API, like any web or chat client. Quit any time; the session keeps going, and `pi-cloud -c` reattaches from
this or any other machine.

```sh
cd ~/code/api
PI_CLOUD_URL=https://pi.example.com PI_CLOUD_API_KEY=... pi-cloud      # new cloud session on origin@<branch>
pi-cloud -c                                                            # continue this repository's latest
pi-cloud -r ses_...                                                    # attach to any session (GitHub, Slack, ...)
```

Local commits and changes are not in the cloud: push first (the CLI says when the branch is ahead of origin).

```
 clients (TUI, web, Slack, ...)
        │  public HTTP API + server-sent events
        ▼
 ┌──────────────── control plane ────────────────┐
 │ SessionStore   sessions and their specs        │
 │ StateStore     Pi Durable storage per session  │◄── swappable: memory, SQLite, Postgres, ...
 │ LeaseManager   one writer per session, fenced  │
 │ EventHub       live events, late-join buffer   │
 │ RunnerDispatcher  "start a runner somewhere"   │◄── swappable: in-process, HTTP, ...
 └───────────────────────────────────────────────┘
        ▲  runner RPC (runners only dial out)
        │  attach → lease + commands; storage calls; events; replies
 ┌──────┴──── runner (any substrate) ────────────┐
 │ Pi Durable harness on RemoteStorage            │
 │ plugins: models, tools, sandboxes, commands    │──► sandbox provider (local, Modal, CF, ...)
 └───────────────────────────────────────────────┘
```

## How a session runs

1. `POST /v1/sessions` stores a session and its spec (model, instructions, sandbox templates, plugin config).
2. `POST /v1/sessions/:id/messages` needs a runner. If none holds the session's lease, the control plane asks its
   `RunnerDispatcher` to start one and waits for it to **attach**.
3. The runner attaches over the runner RPC and receives a **lease** (a fencing token plus the session spec), then a
   stream of commands. It opens Pi Durable on the control plane's storage: every commit goes to the control plane
   and is checked against the lease when it is applied, so a runner that lost its lease cannot write. Reads come
   from a **read replica**: with the SQLite state store, the runner loads a copy of the session's tables when it
   takes the lease and applies each commit to it after the control plane has. It is the only writer while it holds
   the lease, so the copy is never behind; both copies must number every commit the same, or the replica is dropped
   and reads go to the control plane. One turn with a tool call is 14 round trips (its commits) instead of 61.
4. The runner publishes Pi's per-commit agent events; the control plane fans them out to
   `GET /v1/sessions/:id/events`. Reads such as `GET /v1/sessions/:id/entries` come straight from the state store
   and work with no runner at all.
5. An idle runner releases its lease and stops. A runner that dies stops renewing it. When a lease expires without
   a release, the control plane wakes the session again and Pi resumes unfinished work from its last checkpoint.

## Packages

The workspace is a stack of small libraries, each building on the ones below it, the way Pi's own packages do
(`pi-ai` → `pi-durable` → the coding agent). Nothing reaches upward, and every substrate-specific piece is a leaf.

| Layer | Package | What it is |
|---|---|---|
| Contracts | `@pi-cloud/protocol` | Wire contracts only: domain schemas, `SessionCommand`s, the public `HttpApi`, the session channel messages, the runner `RpcGroup`. |
| Config | `@pi-cloud/config` | The catalogue of settings and secrets, the typed schemas built from it, and the environment-then-secrets-directory provider. |
| Primitives | `@pi-cloud/core` | The interfaces everything else builds on (`SessionStore`, `StateStore`, `LeaseManager`, `EventHub`, `RunnerDispatcher`, `BindingStore`) with in-memory reference implementations. No I/O. |
| Control plane | `@pi-cloud/control-plane` | Composes `core` into `Sessions` (the one programmatic API) and serves it as REST, the WebSocket channel, and the runner RPC. `./node` serves it on Node; `ControlPlane.toWebHandler` on fetch-style runtimes. |
| Runtime | `@pi-cloud/runner` | Hosts Pi Durable against the control plane: `RemoteStorage`, the session runner, `RunnerHost` with a fetch-style wake handler, and the plugin API. Uses only `fetch`. |
| Capabilities | `@pi-cloud/sandbox` | The `SandboxProvider` interface, the agent's `sandbox_create`/`sandbox_destroy` tools as a runner plugin, and `shellEnv`, Pi's file and shell interface over any remote shell. |
| | `@pi-cloud/triggers` | One-way events: the `Trigger` interface, a generic signed JSON webhook, and the extension that mounts triggers. |
| | `@pi-cloud/pi` | Pi's coding agent for runners: its system prompt (tools, rules, `AGENTS.md`, skills) and `subagent` tool, as Pi's durable mode runs them. |
| | `@pi-cloud/sources` | Two-way connections: the `Source` interface (receive messages, deliver replies) and the extension that runs them. |
| Adapters | `@pi-cloud/sandbox-local` | Sandboxes as directories on the runner's machine. No isolation. |
| | `@pi-cloud/sandbox-docker` | One Docker container per sandbox, kept across runner restarts; secrets passed per command, never baked in. |
| | `@pi-cloud/sandbox-daytona` | One Daytona sandbox (an isolated VM) per sandbox; persists while stopped and restarts on the next command. |
| | `@pi-cloud/trigger-github` | GitHub webhooks: issues, comments, pull requests and reviews reach the session of their thread. |
| | `@pi-cloud/github-app` | GitHub App authentication: the control plane mints installation tokens, limited to each session's repository, and issues them to its runner as `GITHUB_TOKEN`. Web Crypto, so it runs on Workers too. |
| | `@pi-cloud/tool-github` | GitHub tools for the agent (`github_comment`, `github_open_pull_request`), run by the runner so the token stays out of sandboxes. |
| | `@pi-cloud/source-slack` | Slack: each thread is a session; mentions and thread replies go in, answers are posted in the thread. |
| | `@pi-cloud/storage-sqlite` | Every control-plane store in one SQLite file (`sqliteStores`): the session registry, each session's Pi state (Pi's own SQLite storage, tables prefixed per session), bindings, and credentials. For Node. |
| Clients | `@pi-cloud/client` | Typed REST client derived from the API, `followEvents`, `openChannel` (the WebSocket channel), and `connectServices` (the service API: a Chord client host). |
| | `@pi-cloud/tui` | Pi's own durable TUI as a projection of the service API: it renders objects' state and calls their methods, nothing else. |
| | `@pi-cloud/cli` | `pi-cloud`: the TUI by default; `new`, `ls`, `chat` (line mode), `send`, `tail`, `rm` for scripts. |
| Apps | `apps/local` | Control plane and runner in one process (`main.ts`), or split (`control-plane.ts`, `runner.ts`). The end-to-end tests live here. |
| | `apps/cloudflare` | pi-cloud on Cloudflare: the control plane as one Durable Object holding the central SQLite, one Durable Object per session as its runner. Deployed with Wrangler. |

## Talking to a session

Every surface accepts the same `SessionCommand`s: `Prompt` (with `whenBusy`: `followUp`, `steer`, `reject`),
`Abort`, `Configure` (model, thinking level, instructions), `Compact`, `Reset`, and `Custom` (handled by a runner
plugin). Every surface reads the same Pi agent events (`message_start`, `message_update`, `tool_execution_*`,
`run_end`, ...).

- **WebSocket channel**, `GET /v1/sessions/{id}/channel`: send `{"_tag":"Command","id","command"}`, receive
  `{"_tag":"Events","batch"}` and `{"_tag":"Result","id","result"}` on the same socket. This is what interactive
  surfaces (TUIs, web UIs, chat bridges) use. Resume with `?after=<epoch>:<seq>`; authenticate with the
  `Authorization: Bearer` header (keys are never accepted in URLs, which proxies and logs keep).
- **REST**: `POST /v1/sessions/{id}/commands` runs any command; `/messages` and `/abort` are shortcuts.
  `GET /v1/sessions/{id}/events` streams events as server-sent events. Transcript and submission reads come
  straight from the state store, with or without a running runner.
- **OpenAPI** at `/openapi.json`, browsable docs at `/docs`, generated from the same definition the server and the
  typed client use. The channel's message schemas live in `@pi-cloud/protocol` (`Channel.ts`).

### Services

Presentations that render a session (TUIs, web UIs, dashboards) use the **service API**: Chord objects
(`@earendil-works/chord`, the runtime Pi Durable is built on). The control plane is the Chord host `server`, reached
over a WebSocket at `/v1/pi`. Each session's runner is the host `session:<id>`: the control plane relays references
to it over the runner's own lease-fenced channel, waking a runner when the first reference arrives. A client never
names a host; each contract says where its objects live.

| Object | Lives on | What it is |
|---|---|---|
| `pi-cloud.sessions` | `server` | every session with its title, spec and runner state, live; create with a spec, remove |
| `pi-cloud.session` `{ session }` | `session:<id>` | the session's conversations (the root and each subagent's), the models the runner can use, Pi Durable's live task graph, and notices (prompts that ended unanswered, compaction outcomes, runner warnings); refresh models, abort a task |
| `pi-cloud.conversation` `{ session, conversation }` | `session:<id>` | one conversation: Pi Durable's view of it (entries, streaming message, running tools, queue, agent, usage) and its model configuration; prompt, steer, follow up, cancel queued input, abort, compact, wait for an answer, select a model or thinking level |

State members replicate as a snapshot followed by deltas of exactly what Pi commits; methods are calls, validated
against the contract's schemas on both ends. Runner plugins can serve more object types on the session's host as
Chord facets (`PluginParts.facets`). Objects a presentation holds keep the session's runner alive. When the runner
goes away, its objects end (`gone`); `follow` gets the reference again, which wakes a new runner with the same
durable state.

```ts
const connection = await connectServices({ url, apiKey })                    // @pi-cloud/client
const main = await follow(() => connection.conversation(sessionId))          // the root conversation, across runners
main.current.view.subscribe((view) => render(view))                          // Pi Durable's ConversationView
const response = await main.current.prompt({ message: "hi" })
if (response.accepted) console.log(await main.current.waitForPrompt({ operationId: response.operationId }))
```

Pi's TUI is a projection of exactly these objects (`@pi-cloud/tui`): it renders their state and calls them.
REST, server-sent events and the session channel remain for scripts and for clients in other languages.

## Sources and triggers

The control plane talks to the outside world in two shapes, both built as extensions on `Sessions`:

- **Triggers** are one-way. A webhook arrives, is verified, and becomes events, each about one external thing
  (`github:acme/api#42`). The event becomes a prompt for that thing's session, which is created on first use and
  woken if idle. The session cannot answer through a trigger; to act it uses tools (comment on the PR, update the
  ticket). Mounted at `POST /v1/triggers/{name}`.
- **Sources** are two-way. Inbound messages become prompts exactly like triggers, and every new assistant message in
  the session is delivered back to where the conversation lives (the Slack thread). Mounted at
  `POST /v1/sources/{name}`.

A **binding** ties an external key to its session (and, for sources, to the reply target and the newest delivered
reply), so redelivered webhooks are deduplicated, the same thread always reaches the same session, and replies are
sent once even across restarts.

```ts
ControlPlane.layer({
  // ...
  ...sqliteStores({ file: "data/pi-cloud.sqlite" }),   // sessions, state, bindings, credentials
  extensions: [
    triggers([githubTrigger({
      secret,
      mention: "@pi",
      spec: (repository) => ({
        model,
        sandbox: "repo",
        sandboxes: { repo: { provider: "local", repository: { url: `https://github.com/${repository}.git`, credential: "GITHUB_TOKEN" } } }
      })
    })]),
    sources([slackSource({ signingSecret, botToken, spec: { model } })])
  ]
})
```

Writing another one means implementing a small interface: a `Trigger` is a name and
`handle(request) → events`; a `Source` adds `deliver(target, reply)`. Signature helpers (`hmacSha256Hex`,
`safeEqual`, `verifyHmac`) use Web Crypto, so connectors run on any runtime. The servers enable GitHub when
`GITHUB_WEBHOOK_SECRET` is set (and `GITHUB_MENTION` to filter), Slack when `SLACK_SIGNING_SECRET` and
`SLACK_BOT_TOKEN` are.

**A GitHub round trip.** Someone comments `@pi why is CI red?` on a pull request. The trigger creates (or wakes) the
session for `acme/api#7`, records the thread in `spec.metadata.github`, and asks the agent to work in a `repo`
sandbox: a clone of the repository (provider from `GITHUB_SANDBOX_PROVIDER`). With a GitHub token, the agent has
`github_comment`, which defaults to that thread, and `github_open_pull_request`. Those tools run in the runner, not
the sandbox. The sandbox clones and pushes with the same token, which git gets through a credential helper, never
in a command, URL or `.git/config`; any output that contains it is masked.

**GitHub App (recommended).** One command creates it from pi-cloud's manifest and stores its credentials:

```sh
pi-cloud github-app --url https://pi.example.com --org acme   # in the directory with secrets.yaml / .sops.yaml
```

It opens GitHub with the App filled in (private; contents, issues and pull requests write, metadata read; the
trigger's events; its webhook at `<url>/v1/triggers/github`), you click Create, and GitHub's redirect back to the
command hands over the App's ID, private key and webhook secret, which go straight into `secrets.yaml` as
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` through `sops edit` (never on a command line or
in a plaintext file). Then install the App on your repositories from the link it prints, and restart the control
plane. GitHub has no API that creates an App without that click, so this is a command rather than an infrastructure
resource. `--manifest` prints the manifest, `--print` prints the credentials instead of storing them, and without a
public `--url` the App has no webhook (tokens only). Runners need nothing GitHub-related. Then:

- a session's `GITHUB_TOKEN` is an installation token for the repositories its spec names (the trigger's thread and
  its sandboxes' GitHub repositories, of one account), with just those permissions, for an hour. A session about no
  repository gets none. An agent working on `acme/api` cannot touch `acme/billing`;
- the control plane mints it on request over the lease-checked runner RPC; the runner caches it and asks again two
  minutes before it expires, and every sandbox command gets the current one, so long sessions keep pushing;
- the App's private key never leaves the control plane; the agent acts as `your-app[bot]`, whose own comments the
  trigger ignores.

Without an App, the runner's `GITHUB_TOKEN` (a personal or fine-grained token) is used instead: it is long-lived and
reaches whatever it can reach, and reaches sandboxes only if listed in `SANDBOX_SECRETS`.

## Running it

Requires Node 22.19+ and pnpm, or Nix. Packages run as TypeScript directly (Node strips the types).

```sh
nix develop        # dev shell: Node 22, pnpm, sops, age
pnpm install
pnpm test          # conformance, end to end, channel, crash recovery, fencing, sandboxes, connectors, config, ...
pnpm typecheck

# Everything in one process, state in apps/local/.data (DATA_DIR), secrets from secrets.yaml (see Credentials)
sops exec-env secrets.yaml 'pnpm start'   # API on :8787, docs at /docs, OpenAPI at /openapi.json
cd ~/code/api && PI_CLOUD_URL=http://127.0.0.1:8787 node ~/pi-cloud/packages/cli/src/main.ts   # Pi's TUI, agent in the cloud
```

Split deployment: the control plane wakes runners over HTTP (`RUNNER_URL`), and runners attach back
(`CONTROL_PLANE_URL`); both share `PI_CLOUD_RUNNER_SECRET`.

```sh
sops exec-env secrets.yaml 'node apps/local/src/runner.ts'          # on the runner machine
sops exec-env secrets.yaml 'node apps/local/src/control-plane.ts'   # on the control plane machine
```

**Backups.** Everything the control plane keeps is one file, `DATA_DIR/pi-cloud.sqlite`. Run the server under
[Litestream](https://litestream.io) and every change is streamed to object storage (S3, Cloudflare R2, GCS, ...)
within a second; a host that starts without the file restores it from there (see `litestream.example.yml`, or set
`services.pi-cloud.backup` on NixOS). Runners keep nothing.

```sh
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists .data/pi-cloud.sqlite
sops exec-env secrets.yaml 'litestream replicate -config litestream.yml -exec "pnpm start"'
```

**On Cloudflare** (`apps/cloudflare`), everything runs on Durable Objects, in the same architecture:

- the **control plane is one Durable Object**. Its SQLite is the central store, laid out exactly like
  `pi-cloud.sqlite` (the registry, bindings, credentials, and every session's Pi tables), with Cloudflare's
  point-in-time recovery instead of Litestream;
- **each session's runner is its own Durable Object**. It loads the session's read replica into its own SQLite and
  commits through the control plane object, fenced by the lease, over the object's stub rather than the internet;
- a Worker routes every public request (REST, the service API's WebSocket) to the control plane object; the runner
  RPC is not reachable from outside.

```sh
cd apps/cloudflare
pnpm exec wrangler secret put PI_CLOUD_API_KEYS          # required, as are PI_CLOUD_RUNNER_SECRET and PI_CLOUD_CREDENTIAL_KEY
pnpm exec wrangler secret put ANTHROPIC_API_KEY          # and OPENAI_API_KEY, ...
pnpm run deploy                                          # wrangler deploy
pnpm run dev                                             # the same, in a local workerd
PI_CLOUD_URL=https://pi-cloud.<you>.workers.dev pi-cloud # Pi's TUI against it
```

## Security

pi-cloud fails closed: anything reachable from another machine refuses to start, or to answer, without its secrets.

| Surface | Guarded by | Without it |
| --- | --- | --- |
| Public API (REST, `/v1/pi`, the channel) | `PI_CLOUD_API_KEYS`, as `Authorization: Bearer` | all-in-one on loopback: open; on any other `HOST`: refuses to start; split control plane and Cloudflare: refuse |
| Runner RPC (`/internal/runner`: session state, stored credentials) | `PI_CLOUD_RUNNER_SECRET`, checked on every call | all-in-one: a random secret per start; split and Cloudflare: refuse |
| Runner wake endpoint | the runner secret, and a pinned `CONTROL_PLANE_URL` | refuses every wake (503), so a forged wake can never send a runner, with its model keys and sandbox secrets, to another control plane |
| Stored model credentials | `PI_CLOUD_CREDENTIAL_KEY` (AES-256-GCM) | all-in-one on loopback: stored as plain JSON; everywhere else: refuses |
| Cloudflare's runner RPC | not routed at all: the Worker forwards an allowlist of public paths (`/v1/...`, `/health`, `/docs`, `/openapi.json`, no `%` or `//`), and session objects call the control plane object directly, with the runner secret | the Worker answers 503 until all three secrets are set |

Secrets are compared in constant time. A session's runner can reach only its own session's host through the
service API, and not the session directory. Generate secrets with `openssl rand -base64 32`, keep them in
`secrets.yaml` (SOPS) or `wrangler secret put`, never in `.env` or `.dev.vars` (both are gitignored for local
experiments). Browser UIs cannot set headers on a WebSocket: serve them from the same origin behind a proxy that adds
the key.

## Credentials

Single tenant, so the model is simple: the operator's secrets live in one SOPS-encrypted file, every server reads
them through one typed schema, and nothing else ever reads the environment.

**One catalogue.** `@pi-cloud/config` lists every setting and secret (`SETTINGS`) and builds the two schemas from
it: `ControlPlaneEnv` and `RunnerEnv` (`CloudflareEnv` on Cloudflare). Secrets are `Redacted`, so they never
print. A missing or malformed value stops startup with one line naming it. `pi-cloud-config` (or
`node apps/local/src/config.ts`) shows what is set and where from, never the values.

**One encrypted file.** `secrets.yaml` is encrypted with [SOPS](https://github.com/getsops/sops) and age and can be
committed: key names stay readable, values do not, and `.sops.yaml` says who can decrypt (your key, each server's
host key).

```sh
age-keygen -o ~/.config/sops/age/keys.txt        # once; put the public key in .sops.yaml
cp secrets.example.yaml secrets.yaml && sops encrypt --in-place secrets.yaml
sops secrets.yaml                                # edit later
```

**Every deployment reads it the same way.**

| Where | How the values arrive |
|---|---|
| Development | `sops exec-env secrets.yaml '<command>'`: decrypted into that process's environment only. |
| NixOS | sops-nix decrypts to `/run/secrets/*`; the `nixosModules.default` service receives them with systemd `LoadCredential`, and the config reads `$CREDENTIALS_DIRECTORY`. Nothing in the Nix store or the environment. |
| Containers / other | Mount files named after each setting and set `PI_CLOUD_SECRETS_DIR`. |
| Cloudflare | `wrangler secret put <NAME>` for each secret in `CloudflareEnv`; the Worker reads them from its bindings. |

```nix
# NixOS, with sops-nix
sops.secrets.ANTHROPIC_API_KEY.sopsFile = ./secrets.yaml;
sops.secrets.GITHUB_TOKEN.sopsFile = ./secrets.yaml;
services.pi-cloud = {
  enable = true;
  settings = { SANDBOX_SECRETS = "GITHUB_TOKEN"; GITHUB_MENTION = "@pi"; };
  sandboxTemplates.api = {   # becomes SANDBOX_TEMPLATES_FILE; `pi-cloud chat --sandbox api`
    provider = "local";
    repository = { url = "https://github.com/acme/api.git"; credential = "GITHUB_TOKEN"; };
    setup = [ "npm ci" ];
  };
  secrets = {
    ANTHROPIC_API_KEY = config.sops.secrets.ANTHROPIC_API_KEY.path;
    GITHUB_TOKEN = config.sops.secrets.GITHUB_TOKEN.path;
  };
  backup = {   # Litestream: pi-cloud.sqlite streamed to R2, restored on a fresh host
    enable = true;
    url = "s3://my-bucket/pi-cloud";
    endpoint = "https://<account-id>.r2.cloudflarestorage.com";
    environmentFile = config.sops.templates.litestream.path;   # LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY
  };
};
```

**Subscription logins.** Instead of API keys, sessions can use a subscription: ChatGPT Plus/Pro (`openai-codex`),
Claude Pro/Max (`anthropic`), GitHub Copilot, and the other logins pi-ai supports. Sign in once from your machine;
the login flow is Pi's own, in your browser, and the tokens go to the control plane, which stores them encrypted
(`PI_CLOUD_CREDENTIAL_KEY`). Every runner uses them through the runner RPC and refreshes them when they expire;
writes are compare-and-swap, so runners refreshing at the same time do not lose each other's tokens.

```sh
pi-cloud login openai-codex          # ChatGPT Plus/Pro, in the browser (or device code on a headless machine)
pi-cloud login anthropic             # Claude Pro/Max
pi-cloud login --from-codex          # reuse the login of `codex login` (~/.codex/auth.json)
pi-cloud login --from-pi anthropic   # reuse a login made with Pi (~/.pi/agent/auth.json)
pi-cloud auth                        # what is stored (never the tokens)
pi-cloud logout anthropic
```

Two cautions. A subscription's terms are the provider's: Anthropic, for one, restricts using Claude Pro/Max logins
outside its own apps, so check what yours allows before relying on it. And an imported login is shared with the
tool it came from: when one side refreshes the token, providers that rotate refresh tokens sign the other out;
`pi-cloud login` makes a separate login instead.

**Where each secret goes.**

- Model keys go to the model providers explicitly (`modelCredentials`); pi-ai does not read the environment.
  Stored credentials (`pi-cloud login`) come from the control plane; they never reach a sandbox or the transcript.
- `GITHUB_TOKEN`, with a GitHub App, is issued per session by the control plane, limited to the session's
  repository and an hour; the App's key stays on the control plane. Without one, the runner's own `GITHUB_TOKEN` is
  used by its GitHub tools and reaches a sandbox only if listed in `SANDBOX_SECRETS`.
- Sandboxes get only what their template asks for, and only names the operator listed in `SANDBOX_SECRETS`.
  Everything else in the runner's environment (model keys, the runner secret) never reaches a sandbox: local
  sandboxes run commands with a minimal base environment.
- Secret values that reach a sandbox are masked as `[secret:NAME]` in command output and tool results before they
  are stored, so a prompt-injected agent (GitHub and Slack text is other people's) cannot read them back out
  through the transcript.
- Webhook and Slack secrets stay in the control plane; the runner secret is shared by control plane and runners.

## Extending it

Everything substrate-specific is behind an interface you can replace.

**Control plane services** are Effect services from `@pi-cloud/core`; pass your own layer to `ControlPlane.layer`:

```ts
ControlPlane.layer({
  settings: { publicUrl },
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret }), // or .make(fn), or your own Layer
  state: StateStore.fromOpener({ open: (sessionId) => openMyStorage(sessionId) }),
  sessions: mySessionStore,   // Layer<SessionStore>
  leases: myLeaseManager,     // Layer<LeaseManager>
  events: myEventHub,         // Layer<EventHub>
  clientAuth: myAuth,         // Layer<ClientAuth>, used by REST and the channel alike
  extensions: [slackBridge]   // extra routes built on the Sessions service
})
```

**Extensions** are layers that add routes on top of the `Sessions` service. They are where hosted sources (a
Slack bridge: inbound webhooks become `Prompt`s, events become replies) and event triggers (a GitHub webhook that
wakes a session) plug in, without touching the control plane:

```ts
const githubTrigger: Extension = Layer.effectDiscard(Effect.gen(function*() {
  const router = yield* HttpRouter.HttpRouter
  const sessions = yield* Sessions
  // handleGithubHook verifies the signature, picks a session, and calls sessions.command(id, { _tag: "Prompt", ... })
  yield* router.add("POST", "/hooks/github", handleGithubHook(sessions))
}))
```

A state backend is any Pi Durable `Storage`. Check it with Pi's conformance suite
(`registerStorageConformance` from `@earendil-works/pi-durable/testing`), as `packages/runner/test` does for
`RemoteStorage`.

**Runner plugins** contribute to each hosted session, tailored to its spec:

```ts
const myPlugin = definePlugin({
  name: "github",
  setup: ({ session, config, secrets }) => ({
    extensions: [defineExtension({ name: "github", tools: [prTool], sections: [guide] })], // Pi extensions
    models: (models) => models.setProvider(myProvider()),                                  // model providers
    env: (target, context) => undefined,                                                   // execution environments
    settings: { retry: { maxRetries: 3 } },                                                // harness settings
    commands: { "github.sync": async (payload, session) => ({ ok: true }) },               // custom commands
    ready: async (session) => {},
    dispose: async () => {}
  })
})
new RunnerHost({ plugins: [modelProviders(anthropicProvider), extensions("coding", CodingTools), myPlugin] })
```

`setup` may return the parts directly, as a promise, or as an Effect. Plugin config comes from the session spec's
`plugins[name]`, and secrets are resolved on the runner, so they never pass through the control plane.

**Sandbox providers** implement three Effect operations. `create` must be idempotent per `key` so a create
interrupted by a crash can be retried:

```ts
interface SandboxProvider {
  readonly name: string
  create(request: { key; template; env }): Effect<SandboxHandle, SandboxError>
  connect(handle, env): Effect<ExecutionEnv, SandboxError> // Pi's file + shell interface
  destroy(handle): Effect<void, SandboxError>
}
```

A provider that is not on the runner's machine implements only a `RemoteShell` (run a `sh` script, optionally
upload a file natively) and returns `shellEnv(shell, { cwd, env })`: every file operation Pi's tools use is then done
with POSIX utilities in the sandbox, commands run in their own session so an abort or timeout kills the whole
process tree, and large output spills to a file in the sandbox. The Docker and Daytona providers are each under
200 lines on top of it.

```jsonc
// SANDBOX_TEMPLATES_FILE
{
  "api": { "provider": "docker", "image": "node:22-bookworm", "repository": { "url": "https://github.com/acme/api.git", "credential": "GITHUB_TOKEN" }, "options": { "memory": "4g", "cpus": "2" } },
  "big": { "provider": "daytona", "image": "node:22-bookworm", "options": { "cpu": 4, "memory": 8 } }
}
```

A template names a `provider`, an optional `repository` to clone (`url`, `ref`, and a `credential` secret name),
`setup` commands, `env`, and `secrets` by name. The operator defines templates once in a JSON file
(`SANDBOX_TEMPLATES_FILE`, or `services.pi-cloud.sandboxTemplates` on NixOS), and every session can use them next to
`scratch` and whatever its own spec adds. `spec.sandbox` (`pi-cloud new --sandbox api`) names the template the agent
should start in. The agent calls `sandbox_create`; from then on Pi's `bash`/`read`/`write`/`edit` run inside that
sandbox. The handle is stored in
the session's durable state, so a runner restarted elsewhere reconnects to the same sandbox.

**Clients** are projections of the same API and event stream. `packages/cli/src/render.ts` is the whole terminal
renderer; a web UI or Slack bot is another renderer over `followEvents`.

## Testing

`pnpm test` runs everything (about a minute and a half). Beyond end-to-end tests of each feature, the guarantees
below are stated as invariants and checked with [fast-check](https://fast-check.dev) against random inputs and
operation sequences; a failure prints the smallest counterexample. Each property was checked by breaking the code
on purpose and confirming the test fails.

| Invariant | Checked by |
|---|---|
| At most one live lease per session; epochs only increase; a superseded token never validates again; abandoned leases are reported once | A model-based test of `LeaseManager` over random acquire, renew, release, expiry and removal sequences (`packages/core/test/lease.test.ts`) |
| Every event subscriber, joining late or resuming after a disconnect, gets an ordered, duplicate-free, gapless stream that starts at a snapshot or right after its cursor | Random publishes, lease changes, subscribes and disconnects (`packages/core/test/events.test.ts`) |
| Only the current lease holder commits; a retried request id applies once; commits get one gapless sequence | Concurrent commit waves from an old and a new holder over the real runner RPC (`apps/local/test/fencing.test.ts`) |
| Every prompt appears once and is answered once, however often runners die | Random runner kills while clients retry with request ids; the test also checks that kills hit running sessions (`apps/local/test/exactly-once.test.ts`) |
| A replica is an exact copy of its session's tables, and only of them | Random tables, types and values through `dumpSqlite`, JSON and `loadDump` (`apps/local/test/dump.test.ts`); session table prefixes never collide or overlap (`packages/storage-sqlite/test/prefix.test.ts`) |
| Every public endpoint and every runner RPC refuses without credentials | Enumerated from the API and RPC definitions, so a new endpoint is covered automatically (`apps/local/test/auth-coverage.test.ts`) |
| The Cloudflare Worker never forwards a path that any decoding or normalization puts outside the public API | 20,000 generated paths, read the ways servers and proxies read them (`apps/cloudflare/test/paths.test.ts`) |
| No secret appears in masked results or in streamed output, however output is chunked; sealed credentials open only with their key and refuse tampering | `packages/sandbox/test/mask.test.ts`, `packages/core/test/secrets.test.ts` |
| A sandbox's files behave exactly like Pi's local environment | Random file operation sequences with awkward names and binary contents, run against `shellEnv` and Pi's `NodeExecutionEnv`, compared result by result, with each known difference named (`packages/sandbox/test/shell-env.test.ts`) |
| A session's GitHub token covers only repositories its spec names, of one account; a reused token always has five minutes left | `packages/github-app/test/github-app.test.ts` |
| Writing secrets into `secrets.yaml` keeps every other key and reads back exactly; doing it twice changes nothing | Checked against a YAML parser, and against real `sops` and `age` when installed (`packages/cli/test/sops.test.ts`) |

These tests found and fixed: streamed command output could carry a secret split across two chunks; two different
session ids could share, or reach into, each other's tables (`.` and `%` both became `s___`); and `shellEnv`
reported missing paths under a file, forced removals there, and renames into them differently from Pi.

## Guarantees and limits

- **One writer per session.** Leases have a TTL (15 s by default) and runners renew them at a third of it. Every
  storage call and commit from a runner carries the lease token, and the control plane checks it, under a
  per-session lock, before applying a commit.
- **Crash recovery is Pi's.** After a crash, a cut-off model request is sent again. A cut-off tool call reruns only
  if the tool is `replay: "safe"`; otherwise the model is told it was interrupted. Submissions with a `requestId`
  are exactly-once.
- **Storage survives blips, not outages.** A runner retries a storage call through transport failures for up to 30 s;
  a commit carries a request id, so a retried one applies once. Past that, Pi Durable fails the session, and the
  runner stops without releasing its lease, so the control plane reopens the session on a fresh runner.
- **One control-plane process.** The default `LeaseManager`, `EventHub`, and runner channels live in memory.
  Running several control-plane instances needs a shared `LeaseManager` whose check is atomic with the state
  store's commit, plus a shared event hub.
- **Source followers live in the control plane process.** With several control-plane instances, each would deliver
  replies; that needs the same shared coordination as leases.
- **Event replay is bounded.** A client that joins late gets the newest snapshot and the batches since it. A
  reconnect with `?after=<epoch>:<seq>` resumes without a snapshot while the gap is still buffered. For the full
  history, read `/entries`.
- **Latency.** Every commit is a round trip to the control plane (reads are local with a replica). Keep runners
  close to it, and consider raising Pi's `settings.progress` intervals, which control how often streaming output
  is committed. A replica needs the SQLite state store and a local SQLite (`memoryReplica` on Node, the session
  object's own SQLite on Cloudflare). Loading the copy costs one transfer of the session per wake.
- **The TUI is Pi's durable TUI.** It is the experimental durable mode Pi 1.1.0 shipped (vendored, MIT; Pi 1.3
  removed it from `pi-coding-agent`), with its feature set: prompting, steering, follow-ups, abort, the model picker,
  thinking levels, `/compact`, `/agents`, `/tasks`. Not there: a session picker, forks and tree navigation,
  extensions, prompt templates, images, `/login`. It loads Pi's UI components from the installed
  `@earendil-works/pi-coding-agent` (1.3.0) by file path, so upgrading Pi needs a check.
- **Pi's agent needs a Node runner.** `@pi-cloud/pi` builds Pi's system prompt from the runner's `~/.pi/agent` and
  the sandbox: `AGENTS.md`/`CLAUDE.md` files are read through the sandbox, wherever it runs, but project skills
  (`.pi/skills`) load only from sandboxes on the runner's filesystem.
- **On Cloudflare, so far:** runners have the model providers (Anthropic, OpenAI, ChatGPT/Codex logins) but no Pi
  prompt, coding tools or sandbox; GitHub and Slack connectors are not wired; the WebSocket session channel
  (`/v1/sessions/:id/channel`) is Node-only, while the service API and REST work. Leases, event buffers and the
  service API's state live in the control plane object's memory: they last while anything talks to it (runners
  renew every few seconds), and clients reconnect if it is evicted. One object is one thread and 10 GB.
  Tested in a local workerd (`apps/cloudflare/test`), not yet on a Cloudflare account.
- **Remote sandboxes poll for file changes** (`watch` compares snapshots every second, `mode: "polling"`), and file
  names containing newlines are not listed correctly. `shellEnv` passes Pi Durable's environment conformance suite
  over a local shell; the Daytona provider is tested against a stand-in for its API, not the live service.
- **Not yet built:** a Postgres state store, a shared lease manager, E2B, Modal and Cloudflare sandbox providers,
  and per-user authentication (today: static API keys and a shared runner secret, see Security). The local sandbox provider has no
  isolation; use `docker` or `daytona` for code you do not trust. Pi Durable is experimental, so pin versions.
