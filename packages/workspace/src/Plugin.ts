import type { Context } from "@earendil-works/chord"
import { defineExtension, section } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { definePlugin, type RunnerPlugin } from "@pi-cloud/runner"
import { dirname, join } from "node:path/posix"
import { remoteEnv } from "./Remote.ts"

/** The files Pi reads project instructions from, in order of preference, as Pi's own CLI does. */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]

const readContextFile = async (env: ExecutionEnv, dir: string, context: Context) => {
  for (const name of CONTEXT_FILES) {
    const path = join(dir, name)
    const info = await env.fileInfo(path, context)
    if (!info.ok || info.value.kind !== "file") continue
    const content = await env.readTextFile(path, context)
    if (content.ok) return { path, content: content.value.replace(/^﻿/, "") }
  }
  return undefined
}

/**
 * Pi's project instructions, loaded like the CLI does: the agent directory's file, then one file per directory
 * from the filesystem root down to the working directory.
 */
export const loadContextFiles = async (
  env: ExecutionEnv,
  options: { readonly cwd: string; readonly agentDir?: string | undefined },
  context: Context
) => {
  const files: Array<{ path: string; content: string }> = []
  if (options.agentDir !== undefined) {
    const global = await readContextFile(env, options.agentDir, context)
    if (global !== undefined) files.push(global)
  }
  const ancestors: typeof files = []
  for (let dir = options.cwd;; dir = dirname(dir)) {
    const file = await readContextFile(env, dir, context)
    if (file !== undefined && !files.some((seen) => seen.path === file.path)) ancestors.unshift(file)
    if (dirname(dir) === dir) break
  }
  return [...files, ...ancestors]
}

/**
 * Sessions with `spec.workspace` work on a client's machine: Pi's file and shell tools run there, in that
 * directory, through whichever client serves the workspace (the TUI does). The project's `AGENTS.md` files become
 * instructions, read once per hosting. Put it after `sandboxes`, so a sandbox the agent creates takes over.
 */
export const workspace = (): RunnerPlugin =>
  definePlugin({
    name: "workspace",
    setup: ({ session, workspace: transport }) => {
      const spec = session.spec.workspace
      if (spec === undefined) return {}
      const env = remoteEnv(transport, { cwd: spec.cwd })
      let instructions: Promise<string | undefined> | undefined
      const context = section("project_context", async (_api, ctx: Context) => {
        instructions ??= loadContextFiles(env, spec, ctx).then(
          (files) =>
            files.length === 0 ? undefined : [
              "Project-specific instructions and guidelines:",
              ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`)
            ].join("\n\n"),
          () => {
            instructions = undefined
            return undefined
          }
        )
        return instructions
      })
      const where = section("workspace", () =>
        `You are working in ${spec.cwd}${spec.host === undefined ? "" : ` on ${spec.host}`}, the developer's own ` +
        `checkout. File and shell tools run there directly.`)
      return {
        env: () => env,
        extensions: [defineExtension({ name: "pi-cloud-workspace", sections: [where, context] })]
      }
    }
  })
