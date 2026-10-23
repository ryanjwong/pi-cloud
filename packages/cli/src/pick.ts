import type { SessionView } from "@pi-cloud/protocol"

const originOf = (session: SessionView) => session.spec.metadata?.origin as { url?: string; branch?: string } | undefined

const newest = (a: SessionView, b: SessionView) => b.createdAt - a.createdAt

export const latestFor = (sessions: ReadonlyArray<SessionView>, origin: { readonly url: string; readonly branch: string } | undefined) =>
  sessions.filter((session) => {
    const saved = originOf(session)
    return origin === undefined ? saved === undefined : saved?.url === origin.url && saved.branch === origin.branch
  }).sort(newest)[0]

const age = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

export const choices = (sessions: ReadonlyArray<SessionView>, repository: string | undefined, now: number) => {
  const ours = (session: SessionView) => Number(repository !== undefined && originOf(session)?.url === repository)
  return [...sessions].sort((a, b) => ours(b) - ours(a) || newest(a, b)).map((session) => ({
    value: session.id,
    label: session.title ?? session.id,
    description: [
      session.runner.state,
      session.spec.model === undefined ? "" : `${session.spec.model.provider}/${session.spec.model.modelId}`,
      age(now - session.createdAt)
    ].filter(Boolean).join("  ")
  }))
}
