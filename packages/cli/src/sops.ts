import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Set top-level keys of a YAML document, replacing any existing entry (with its indented continuation lines) and
 * appending the rest. Multi-line values become block scalars. Enough for a flat secrets file; nothing else is
 * touched.
 */
export const setYamlKeys = (text: string, values: Readonly<Record<string, string>>): string => {
  const keys = new Set(Object.keys(values))
  const kept: Array<string> = []
  let skipping = false
  for (const line of text.split("\n")) {
    const key = line.match(/^([A-Za-z0-9_]+)\s*:/)?.[1]
    if (key !== undefined) skipping = keys.has(key)
    else if (line.trim() !== "" && !/^\s/.test(line)) skipping = false
    if (!skipping) kept.push(line)
  }
  while (kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop()
  const entries = Object.entries(values).map(([key, value]) =>
    value.includes("\n")
      ? `${key}: |\n${value.replace(/\n+$/, "").split("\n").map((line) => `  ${line}`).join("\n")}`
      : `${key}: ${JSON.stringify(value)}`
  )
  return `${[...kept, ...(kept.length === 0 ? [] : [""]), ...entries].join("\n")}\n`
}

/**
 * Write `values` into a SOPS-encrypted file (created with the repository's `.sops.yaml` rules if missing). SOPS
 * decrypts to a private temporary file and runs an "editor", here this module, which sets the keys; SOPS then
 * encrypts it again. Values travel in the editor's environment, never on a command line.
 */
export const writeSopsSecrets = (file: string, values: Readonly<Record<string, string>>) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cloud-sops-"))
  try {
    const editor = join(dir, "editor")
    writeFileSync(editor, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(new URL(import.meta.url).pathname)} "$@"\n`)
    chmodSync(editor, 0o700)
    const result = spawnSync("sops", ["edit", file], {
      stdio: ["inherit", "inherit", "pipe"],
      env: {
        ...process.env,
        EDITOR: editor,
        SOPS_EDITOR: editor,
        PI_CLOUD_SOPS_VALUES: JSON.stringify(values),
        // A new file starts as SOPS's example document, which is dropped.
        PI_CLOUD_SOPS_NEW: existsSync(file) ? "" : "1"
      }
    })
    if (result.error !== undefined) throw new Error(`Could not run sops (${result.error.message}); install it, or pass --print`)
    if (result.status !== 0) throw new Error(`sops failed: ${result.stderr.toString().trim()}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Run as SOPS's editor: set the keys in the decrypted file it hands over.
if (process.argv[1] === new URL(import.meta.url).pathname && process.env.PI_CLOUD_SOPS_VALUES !== undefined) {
  const { readFileSync } = await import("node:fs")
  const target = process.argv[2]!
  const current = process.env.PI_CLOUD_SOPS_NEW === "1" ? "" : readFileSync(target, "utf8")
  writeFileSync(target, setYamlKeys(current, JSON.parse(process.env.PI_CLOUD_SOPS_VALUES)))
}
