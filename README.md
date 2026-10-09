# pi-cloud

A hosted control plane for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) agents.
Clients talk to one API. Each session's durable state lives in a store the control plane owns, and the agent
itself runs in a **runner** that can live anywhere with outbound HTTP: a Node process, a container, a Cloudflare
Durable Object, a Modal function. Sandboxes for the agent's tools are pluggable in the same way.

Written in TypeScript with [Effect](https://effect.website) 4; the Cloudflare deployment uses
[Alchemy](https://alchemy.run).

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
   stream of commands. It opens Pi Durable on `RemoteStorage`: every Pi storage call goes to the control plane,
   and every commit is checked against the lease when it is applied. A runner that lost its lease cannot write.
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
| Primitives | `@pi-cloud/core` | The interfaces everything else builds on (`SessionStore`, `StateStore`, `LeaseManager`, `EventHub`, `RunnerDispatcher`, `BindingStore`) with in-memory reference implementations. No I/O. |
| Control plane | `@pi-cloud/control-plane` | Composes `core` into `Sessions` (the one programmatic API) and serves it as REST, the WebSocket channel, and the runner RPC. `./node` serves it on Node; `ControlPlane.toWebHandler` on fetch-style runtimes. |
| Runtime | `@pi-cloud/runner` | Hosts Pi Durable against the control plane: `RemoteStorage`, the session runner, `RunnerHost` with a fetch-style wake handler, and the plugin API. Uses only `fetch`. |
| Capabilities | `@pi-cloud/sandbox` | The `SandboxProvider` interface and the agent's `sandbox_create`/`sandbox_destroy` tools, as a runner plugin. |
| | `@pi-cloud/triggers` | One-way events: the `Trigger` interface, a generic signed JSON webhook, and the extension that mounts triggers. |
| | `@pi-cloud/sources` | Two-way connections: the `Source` interface (receive messages, deliver replies) and the extension that runs them. |
| Adapters | `@pi-cloud/sandbox-local` | Sandboxes as directories on the runner's machine. |
| | `@pi-cloud/trigger-github` | GitHub webhooks: issues, comments, pull requests and reviews reach the session of their thread. |
| | `@pi-cloud/source-slack` | Slack: each thread is a session; mentions and thread replies go in, answers are posted in the thread. |
| | `@pi-cloud/storage-sqlite` | SQLite `StateStore` (Pi's own SQLite storage, one file per session), `SessionStore` and `BindingStore`, for Node. |
| Clients | `@pi-cloud/client` | Typed REST client derived from the API, `followEvents` (reconnecting event stream), and `openChannel` (the WebSocket channel). |
| | `@pi-cloud/cli` | `pi-cloud` terminal client: `new`, `ls`, `chat`, `send`, `tail`, `rm`. Chat runs over the channel. |
| Apps | `apps/local` | Control plane and runner in one process (`main.ts`), or split (`control-plane.ts`, `runner.ts`). The end-to-end tests live here. |
| | `apps/cloudflare` | Runner host on Cloudflare: a Worker routes wake requests to one Durable Object per session. Deployed with Alchemy. |

## Talking to a session

Every surface accepts the same `SessionCommand`s: `Prompt` (with `whenBusy`: `followUp`, `steer`, `reject`),
`Abort`, `Configure` (model, thinking level, instructions), `Compact`, `Reset`, and `Custom` (handled by a runner
plugin). Every surface reads the same Pi agent events (`message_start`, `message_update`, `tool_execution_*`,
`run_end`, ...).

- **WebSocket channel**, `GET /v1/sessions/{id}/channel`: send `{"_tag":"Command","id","command"}`, receive
  `{"_tag":"Events","batch"}` and `{"_tag":"Result","id","result"}` on the same socket. This is what interactive
  surfaces (TUIs, web UIs, chat bridges) use. Resume with `?after=<epoch>:<seq>`; authenticate with a bearer header
  or `?token=`.
- **REST**: `POST /v1/sessions/{id}/commands` runs any command; `/messages` and `/abort` are shortcuts.
  `GET /v1/sessions/{id}/events` streams events as server-sent events. Transcript and submission reads come
  straight from the state store, with or without a running runner.
- **OpenAPI** at `/openapi.json`, browsable docs at `/docs`, generated from the same definition the server and the
  typed client use. The channel's message schemas live in `@pi-cloud/protocol` (`Channel.ts`).

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
  bindings: sqliteBindings({ file: "data/sessions.sqlite" }),
  extensions: [
    triggers([githubTrigger({ secret, mention: "@pi", spec: { model, sandboxes: { repo: cloneTemplate } } })]),
    sources([slackSource({ signingSecret, botToken, spec: { model } })])
  ]
})
```

Writing another one means implementing a small interface: a `Trigger` is a name and
`handle(request) → events`; a `Source` adds `deliver(target, reply)`. Signature helpers (`hmacSha256Hex`,
`safeEqual`, `verifyHmac`) use Web Crypto, so connectors run on any runtime. The local servers enable GitHub with
`GITHUB_WEBHOOK_SECRET` (and `GITHUB_MENTION`), Slack with `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`.

## Running it

Requires Node 22.19+ and pnpm, or Nix. Packages run as TypeScript directly (Node strips the types).

```sh
nix develop        # dev shell with Node 22 and pnpm (optional)
nix run            # or build and run the all-in-one server; also .#cli, .#control-plane, .#runner
nix flake check    # typecheck and tests in the Nix sandbox
                   # (nix run / flake check need the pnpm dependency hash in flake.nix filled in once)

pnpm install
pnpm test          # conformance, end to end, channel, crash recovery, fencing, reconnects, sandboxes, restart, split
pnpm typecheck

# Everything in one process, state in apps/local/.data (set DATA_DIR to change)
ANTHROPIC_API_KEY=... pnpm start          # API on :8787, docs at /docs, OpenAPI at /openapi.json

# Talk to it
pnpm cli chat --model anthropic/claude-opus-5-5
```

Split deployment: the control plane wakes runners over HTTP, and runners attach back.

```sh
# runner host (any machine that can reach the control plane)
CONTROL_PLANE_URL=http://control:8787 PI_CLOUD_RUNNER_SECRET=s3cret node apps/local/src/runner.ts
# control plane
RUNNER_URL=http://runners:8788/wake PUBLIC_URL=http://control:8787 PI_CLOUD_RUNNER_SECRET=s3cret \
  node apps/local/src/control-plane.ts
```

On Cloudflare (`apps/cloudflare`): `alchemy deploy` with `CONTROL_PLANE_URL`, `PI_CLOUD_RUNNER_SECRET`, and model
keys set, then point the control plane's `RUNNER_URL` at the printed Worker URL.

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

Sessions declare templates (`provider`, `setup` commands, `env`, `secrets` by name). The agent calls
`sandbox_create`; from then on Pi's `bash`/`read`/`write`/`edit` run inside that sandbox. The handle is stored in
the session's durable state, so a runner restarted elsewhere reconnects to the same sandbox.

**Clients** are projections of the same API and event stream. `packages/cli/src/render.ts` is the whole terminal
renderer; a web UI or Slack bot is another renderer over `followEvents`.

## Guarantees and limits

- **One writer per session.** Leases have a TTL (15 s by default) and runners renew them at a third of it. Every
  storage call and commit from a runner carries the lease token, and the control plane checks it, under a
  per-session lock, before applying a commit.
- **Crash recovery is Pi's.** After a crash, a cut-off model request is sent again. A cut-off tool call reruns only
  if the tool is `replay: "safe"`; otherwise the model is told it was interrupted. Submissions with a `requestId`
  are exactly-once.
- **One control-plane process.** The default `LeaseManager`, `EventHub`, and runner channels live in memory.
  Running several control-plane instances needs a shared `LeaseManager` whose check is atomic with the state
  store's commit, plus a shared event hub.
- **Source followers live in the control plane process.** With several control-plane instances, each would deliver
  replies; that needs the same shared coordination as leases.
- **Event replay is bounded.** A client that joins late gets the newest snapshot and the batches since it. A
  reconnect with `?after=<epoch>:<seq>` resumes without a snapshot while the gap is still buffered. For the full
  history, read `/entries`.
- **Latency.** Every commit is a round trip to the control plane. Keep runners close to it, and consider raising
  Pi's `settings.progress` intervals, which control how often streaming output is committed.
- **Not yet built:** a Postgres state store, a shared lease manager, Modal and Cloudflare sandbox providers,
  hosting the control plane itself on Cloudflare, and real authentication (today: static API keys and a shared
  runner secret). The Cloudflare app typechecks but has not been deployed. The local sandbox provider has no
  isolation. Pi Durable is experimental, so pin versions.
