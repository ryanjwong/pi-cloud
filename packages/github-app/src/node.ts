import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { type AppManifestOptions, appManifest, convertManifestCode, type CreatedApp } from "./manifest.ts"

export interface CreateAppOptions extends Omit<AppManifestOptions, "redirectUrl"> {
  readonly org?: string
  readonly port?: number
  readonly open: (url: string) => void
  readonly webUrl?: string
  readonly apiUrl?: string
  readonly fetch?: typeof globalThis.fetch
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">${body}</body>`

export const createApp = (options: CreateAppOptions): Promise<CreatedApp> =>
  new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex")
    const webUrl = (options.webUrl ?? "https://github.com").replace(/\/$/, "")
    const target = options.org === undefined
      ? `${webUrl}/settings/apps/new`
      : `${webUrl}/organizations/${encodeURIComponent(options.org)}/settings/apps/new`
    let settled = false
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const send = (status: number, html: string) => {
        response.writeHead(status, { "content-type": "text/html; charset=utf-8" })
        response.end(html)
      }
      if (url.pathname === "/") {
        const manifest = appManifest({ ...options, redirectUrl: `${base}/callback` })
        return send(200, page("Create the GitHub App", `
          <form id="f" method="post" action="${escapeHtml(`${target}?state=${state}`)}">
            <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
            <p>Opening GitHub to create <b>${escapeHtml(manifest.name)}</b>&hellip;</p>
            <button>Continue to GitHub</button>
          </form>
          <script>document.getElementById("f").submit()</script>`))
      }
      if (url.pathname !== "/callback") return send(404, page("Not found", "Not found"))
      if (url.searchParams.get("state") !== state || settled) return send(400, page("Stale link", "This link is not from this run."))
      const code = url.searchParams.get("code")
      if (code === null) return send(400, page("No code", "GitHub sent no code."))
      settled = true
      try {
        const created = await convertManifestCode(code, options)
        send(200, page("Done", `<p>Created <a href="${escapeHtml(created.htmlUrl)}">${escapeHtml(created.slug)}</a>. ` +
          `Install it on your repositories from its page; you can close this tab.</p>`))
        resolve(created)
      } catch (error) {
        send(500, page("Failed", escapeHtml(error instanceof Error ? error.message : String(error))))
        reject(error)
      } finally {
        server.close()
      }
    })
    let base = ""
    server.on("error", reject)
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      options.open(base)
    })
  })
