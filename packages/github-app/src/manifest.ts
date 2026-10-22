export const APP_PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read" } as const

export const APP_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"] as const

export interface AppManifestOptions {
  readonly name?: string
  readonly publicUrl?: string
  readonly redirectUrl: string
  readonly description?: string
}

export const appManifest = (options: AppManifestOptions) => {
  const publicUrl = options.publicUrl?.replace(/\/$/, "")
  return {
    name: options.name ?? "pi-cloud",
    description: options.description ?? "Pi agents that work on this account's repositories: comment, push branches, open pull requests.",
    url: publicUrl ?? "https://github.com",
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    ...(publicUrl === undefined
      ? {}
      : { hook_attributes: { url: `${publicUrl}/v1/triggers/github`, active: true }, default_events: APP_EVENTS })
  }
}

export interface CreatedApp {
  readonly id: number
  readonly slug: string
  readonly htmlUrl: string
  readonly privateKey: string
  readonly webhookSecret?: string
}

export const convertManifestCode = async (
  code: string,
  options: { readonly apiUrl?: string; readonly fetch?: typeof globalThis.fetch } = {}
): Promise<CreatedApp> => {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "")
  const response = await (options.fetch ?? globalThis.fetch)(`${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "pi-cloud", "x-github-api-version": "2022-11-28" }
  })
  const body = (await response.json().catch(() => ({}))) as {
    id?: number
    slug?: string
    html_url?: string
    pem?: string
    webhook_secret?: string | null
    message?: string
  }
  if (!response.ok || body.id === undefined || body.pem === undefined) {
    throw new Error(`GitHub ${response.status} converting the App manifest: ${body.message ?? response.statusText}`)
  }
  return {
    id: body.id,
    slug: body.slug ?? "",
    htmlUrl: body.html_url ?? "",
    privateKey: body.pem,
    ...(typeof body.webhook_secret === "string" ? { webhookSecret: body.webhook_secret } : {})
  }
}
