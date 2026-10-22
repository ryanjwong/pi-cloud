# Testing

```sh
pnpm test         # everything, about a minute and a half
pnpm typecheck
```

Docker tests need a running Docker daemon. The SOPS tests run only when `sops` and `age` are installed (they are in
`nix develop`).

Most features have end-to-end tests in `apps/local/test`. The properties below are also checked with
[fast-check](https://fast-check.dev) against random inputs and operation sequences. On failure it prints the
smallest input that breaks the property. Each of these tests was also run against deliberately broken code, to make
sure it fails.

| Property | Test |
|---|---|
| One live lease per session; epochs only rise; a replaced token never works again | `packages/core/test/lease.test.ts`, against a reference model |
| Late and reconnecting event subscribers get every batch once, in order | `packages/core/test/events.test.ts` |
| Only the lease holder commits; a retried commit applies once; sequence numbers have no gaps | `apps/local/test/fencing.test.ts` |
| Every prompt is recorded and answered exactly once while runners are killed at random | `apps/local/test/exactly-once.test.ts` |
| A replica holds exactly its session's tables and values | `apps/local/test/dump.test.ts`, `packages/storage-sqlite/test/prefix.test.ts` |
| Every API endpoint and runner RPC refuses without credentials | `apps/local/test/auth-coverage.test.ts`, which lists them from their definitions |
| The Worker never forwards a path that decodes to a non-public one | `apps/cloudflare/test/paths.test.ts` |
| No secret survives masking, however output is split into chunks | `packages/sandbox/test/mask.test.ts` |
| Sealed credentials open only with their key | `packages/core/test/secrets.test.ts` |
| Sandbox files behave like Pi's local environment | `packages/sandbox/test/shell-env.test.ts`, comparing `shellEnv` with `NodeExecutionEnv` |
| GitHub tokens cover only the session's repositories | `packages/github-app/test/github-app.test.ts` |
| Writing to `secrets.yaml` keeps other keys and reads back exactly | `packages/cli/test/sops.test.ts` |

Not covered: real model providers, a real Cloudflare account, and the live GitHub and Daytona APIs. Those tests use
stand-ins.
