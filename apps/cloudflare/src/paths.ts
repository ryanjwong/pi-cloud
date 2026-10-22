const isPublic = (path: string) =>
  path === "/health" || path === "/docs" || path === "/openapi.json" || /^\/v1\/[A-Za-z0-9]/.test(path)

export const forwarded = (path: string) => isPublic(path) && !path.includes("%") && !path.includes("//")
