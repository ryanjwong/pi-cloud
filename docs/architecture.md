# Architecture

```
 clients: pi-cloud TUI, REST, Slack, GitHub
        │
        ▼
 ┌──────────── control plane ────────────┐
 │ sessions and their specs              │
 │ each session's Pi Durable state       │  one SQLite file, or a Durable Object's SQLite
 │ leases: one writer per session        │
 │ live events, buffered for late joins  │
 │ dispatcher: "start a runner somewhere"│
 └───────────────────────────────────────┘
        ▲  runner RPC (runners only connect out)
        │
 ┌──────┴───────── runner ───────────────┐
 │ Pi Durable, storing to the control    │
 │ plane; plugins: models, tools, ...    │──► sandbox (local, Docker, Daytona)
 └───────────────────────────────────────┘
```

The control plane owns all state. A runner owns nothing: it hosts sessions while it holds their leases, and any
runner can pick a session up from where the last one stopped.

## A session's life

1. A client creates a session with a spec: model, instructions, and sandboxes that narrow the operator's templates.
   The control plane checks it and stores the resolved templates and repository binding on the session.
2. The first prompt needs a runner. If no runner holds the session's lease, the dispatcher starts one (in process,
   over HTTP, or as a Durable Object), and it connects back.
3. The runner takes the **lease**, a token that fences its writes. It opens Pi Durable with storage that commits
   to the control plane. The control plane checks the token on every commit, so a runner that lost its lease can't
   write.
4. Reads come from a local **replica**. When the runner takes the lease, it loads a copy of the session's tables and
   applies each commit to it after the control plane has. It is the only writer, so the copy can't fall behind. If
   the two copies ever number a commit differently, the replica is dropped and reads go to the control plane. In
   tests this cut a turn with one tool call from 61 round trips to 14, one per commit.
5. The runner publishes Pi's events. The control plane fans them out to clients and keeps a buffer since the last
   snapshot, so late joiners can catch up.
6. An idle runner releases the lease and stops. A runner that dies just stops renewing it. When a lease expires
   without a release, the control plane wakes the session on a new runner, and Pi resumes unfinished work from its
   last checkpoint.

What survives a crash is Pi Durable's: a model request that was cut off is sent again; a cut-off tool call is rerun
only if the tool is marked `replay: "safe"`, otherwise the model is told it was interrupted. Prompts sent with a
`requestId` are recorded once however often they are retried. A runner retries storage calls through network
failures for up to 30 seconds; after that the session fails over to a new runner.

## Talking to a session

- **Service API**, a WebSocket at `/v1/pi`. Objects for the session list, a session, and each conversation, with
  live state and methods (prompt, steer, abort, compact, choose a model). The TUI uses this. It is built on
  `@earendil-works/chord`, the runtime Pi Durable uses.
- **REST** under `/v1/sessions`, with server-sent events for live output and the transcript readable without a
  runner. OpenAPI at `/openapi.json`, docs at `/docs`.
- **Session channel**, a WebSocket at `/v1/sessions/{id}/channel` that takes commands and streams events (Node
  only).

## Packages

Each package only uses the ones above it in this table.

| Package | What it is |
|---|---|
| `protocol` | Schemas and contracts: the REST API, the runner RPC, the service API objects |
| `config` | Every setting and secret, and the typed schemas that read them |
| `core` | The control plane's interfaces (sessions, state, leases, events, dispatch), with in-memory versions |
| `control-plane` | The server: REST, the service API, the channel, the runner RPC |
| `runner` | Hosts Pi Durable against the control plane; the plugin API |
| `sandbox` | The sandbox provider interface, the agent's sandbox tools, `shellEnv` |
| `sandbox-local`, `sandbox-docker`, `sandbox-daytona` | Sandbox providers |
| `pi` | Pi's coding-agent prompt and subagents, for Node runners |
| `triggers`, `sources`, `trigger-github`, `source-slack` | Connectors |
| `github-app`, `tool-github` | GitHub App tokens; the agent's GitHub tools |
| `connectors` | What a control plane mounts from its settings, on Node and Cloudflare alike |
| `storage-sqlite` | Every control-plane store in one SQLite database |
| `client`, `tui`, `cli` | The typed client, Pi's TUI on the service API, the `pi-cloud` command |
| `apps/local` | The Node servers, and most end-to-end tests |
| `apps/cloudflare` | The Worker and its two Durable Object classes |

## Limits

- One control-plane process at a time. Leases and the event hub are in memory, so several instances would need a
  shared lease manager whose check is atomic with the commit.
- Every commit is a round trip to the control plane, so keep runners close to it.
- A client that joins late gets the newest snapshot plus what followed; for older history, read the transcript.
