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

| Package | What it is |
|---|---|
| `@pi-cloud/protocol` | Wire contracts: domain schemas, the public `HttpApi`, the runner `RpcGroup`, the wake request. |
| `@pi-cloud/control-plane` | The control plane: ports, in-memory defaults, public API and runner RPC handlers. `./node` serves it on Node; `ControlPlane.toWebHandler` serves it on fetch-style runtimes. |
| `@pi-cloud/runner` | Hosts sessions: `RemoteStorage`, the session runner, `RunnerHost` with a fetch-style wake handler, and the plugin API. Uses only `fetch`. |
| `@pi-cloud/sandbox` | The `SandboxProvider` interface, the agent's `sandbox_create`/`sandbox_destroy` tools, and `./local` (directories on the runner's machine). |
| `@pi-cloud/storage-sqlite` | SQLite `StateStore` (Pi's own SQLite storage, one file per session) and `SessionStore` for Node. |
| `@pi-cloud/client` | Typed client derived from the API, plus `followEvents` (reconnecting, resuming event stream). |
| `@pi-cloud/cli` | `pi-cloud` terminal client: `new`, `ls`, `chat`, `send`, `tail`, `rm`. |
| `apps/local` | Control plane and runner in one process (`main.ts`), or split (`control-plane.ts`, `runner.ts`). The tests live here. |
| `apps/cloudflare` | Runner host on Cloudflare: a Worker routes wake requests to one Durable Object per session. Deployed with Alchemy. |

## Running it

Requires Node 22.19+ and pnpm. Packages run as TypeScript directly (Node strips the types).

```sh
pnpm install
pnpm test          # storage conformance, end to end, crash recovery, fencing, reconnects, sandboxes, restart, split deployment
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

**Control plane ports** are Effect services; pass your own layer to `ControlPlane.layer`:

```ts
ControlPlane.layer({
  settings: { publicUrl },
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret }), // or .make(fn), or your own Layer
  state: StateStore.fromOpener({ open: (sessionId) => openMyStorage(sessionId) }),
  sessions: mySessionStore,   // Layer<SessionStore>
  leases: myLeaseManager,     // Layer<LeaseManager>
  events: myEventHub          // Layer<EventHub>
})
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
- **Event replay is bounded.** A client that joins late gets the newest snapshot and the batches since it. A
  reconnect with `?after=<epoch>:<seq>` resumes without a snapshot while the gap is still buffered. For the full
  history, read `/entries`.
- **Latency.** Every commit is a round trip to the control plane. Keep runners close to it, and consider raising
  Pi's `settings.progress` intervals, which control how often streaming output is committed.
- **Not yet built:** a Postgres state store, a shared lease manager, Modal and Cloudflare sandbox providers,
  hosting the control plane itself on Cloudflare, and real authentication (today: static API keys and a shared
  runner secret). The Cloudflare app typechecks but has not been deployed. The local sandbox provider has no
  isolation. Pi Durable is experimental, so pin versions.
