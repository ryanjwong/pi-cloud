/**
 * Whether a path is part of the public API. Only these reach the control plane object from outside: the runner RPC
 * (`/internal/...`) is for session hosts, which call the object directly. An allowlist rather than a denylist, so no
 * spelling of a path (`//internal`, percent-encoding, ...) can reach anything else.
 */
const isPublic = (path: string) =>
  path === "/health" || path === "/docs" || path === "/openapi.json" || /^\/v1\/[A-Za-z0-9]/.test(path)

/** Whether the Worker forwards a request for `path` (a URL's `pathname`) to the control plane object. */
export const forwarded = (path: string) => isPublic(path) && !path.includes("%") && !path.includes("//")
