# Extending

## Runner plugins

A plugin is called once for each session a runner hosts, and returns what it adds to that session: Pi extensions
(tools, prompt sections, hooks), model providers, an execution environment, harness settings, or custom commands.

```ts
import { definePlugin, extensions, modelProviders, RunnerHost } from "@pi-cloud/runner"

const deploy = definePlugin({
  name: "deploy",
  setup: ({ session, config, secrets }) => ({
    extensions: [deployExtension],                          // a Pi extension with your tools
    commands: { "deploy.status": async () => ({ ok: true }) }
  })
})

new RunnerHost({ plugins: [modelProviders(anthropicProvider), extensions("coding", CodingTools), deploy] })
```

`config` is the session spec's `plugins.deploy` entry. `secrets(name)` resolves a secret on the runner, so values
never pass through the control plane. `setup` may return the parts directly, as a promise, or as an Effect. The
full list of parts is `PluginParts` in `packages/runner/src/Plugin.ts`; the default plugin set is in
`apps/local/src/plugins.ts`.

## Sandbox providers

A provider creates, connects to and destroys sandboxes:

```ts
interface SandboxProvider {
  readonly name: string
  create(request: { key, template, env }): Effect<SandboxHandle, SandboxError>
  connect(handle, env): Effect<ExecutionEnv, SandboxError>
  destroy(handle): Effect<void, SandboxError>
}
```

`create` must return the same sandbox for the same `key`, so a create cut off by a crash can be retried. The handle
is plain JSON stored in the session, and `connect` is called again after every runner restart. `ExecutionEnv` is
Pi's file and shell interface, so all of Pi's coding tools work on any provider.

If the sandbox can run a shell script, you don't need to write an `ExecutionEnv`. Implement a `RemoteShell`, whose
main method is `run(script, { env, stdin, signal, onStdout, onStderr })` returning the exit code, and return
`shellEnv(shell, { cwd, env })` from `connect`. That gives you file operations, killing whole process trees on
abort, and output spilling, and it passes Pi's own environment test suite. The Docker and Daytona providers are
built this way, at about 160 lines each.

Add the provider to `apps/local/src/plugins.ts`, then use it by name in a template.

## Sandbox templates

A template names a provider, and optionally a repository to clone, setup commands, environment variables, and
secrets by name. Put shared ones in a JSON file (`SANDBOX_TEMPLATES_FILE`, or `services.pi-cloud.sandboxTemplates`
on NixOS):

```json
{
  "api": {
    "provider": "docker",
    "image": "node:22-bookworm",
    "repository": { "url": "https://github.com/acme/api.git", "credential": "GITHUB_TOKEN" },
    "setup": ["npm ci"],
    "options": { "memory": "4g", "cpus": "2" }
  }
}
```

Sessions can also bring their own templates in their spec. `spec.sandbox` names the one the agent starts in
(`pi-cloud new --sandbox api`), and the agent can make more with `sandbox_create`.

## Control plane services

Every store and service in `ControlPlane.layer` is an Effect layer you can replace:

```ts
ControlPlane.layer({
  settings: { publicUrl },
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret }),   // how runners are started
  ...sqliteStores({ file: "pi-cloud.sqlite" }),                   // sessions, state, bindings, credentials
  leases, events, clientAuth, sessionSecrets,                     // optional replacements
  extensions: [triggers([...]), sources([...])]                   // extra routes
})
```

A state store is any Pi Durable `Storage`. Check yours with Pi's suite, `registerStorageConformance` from
`@earendil-works/pi-durable/testing`, as `packages/runner/test` does.

## Clients

`@pi-cloud/client` has the typed REST client, `followEvents` for live output, and `connectServices` for the
service API, which is what the TUI uses:

```ts
const connection = await connectServices({ url, apiKey })
const main = await follow(() => connection.conversation(sessionId))   // follows the session across runners
main.current.view.subscribe(render)
await main.current.prompt({ message: "hi" })
```
