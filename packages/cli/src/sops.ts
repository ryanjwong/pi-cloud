import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { sopsEnv } from "./settings.ts"

const encodeValue = (value: string) => {
  const body = value.replace(/\n+$/, "")
  const trailing = value.length - body.length
  const plain = /^[\x20-\x7e\n]*$/.test(value) && body.split("\n").every((line) => line === "" || /\S/.test(line))
  if (!value.includes("\n") || body === "" || !plain) return JSON.stringify(value)
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+"
  const lines = [...body.split("\n"), ...Array.from({ length: Math.max(0, trailing - 1) }, () => "")]
  return `|2${chomp}\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}`
}

export const setYamlKeys = (text: string, values: Readonly<Record<string, string>>): string => {
  const keys = new Set(Object.keys(values))
  const kept: Array<string> = []
  let skipping = false
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n")
  for (const line of lines) {
    const key = line.match(/^([A-Za-z0-9_]+)\s*:/)?.[1]
    if (key !== undefined) skipping = keys.has(key)
    else if (line.trim() !== "" && !/^\s/.test(line)) skipping = false
    if (!skipping) kept.push(line)
  }
  const head = kept.map((line) => `${line}\n`).join("")
  return `${head}${Object.entries(values).map(([key, value]) => `${key}: ${encodeValue(value)}`).join("\n")}\n`
}

export const writeSopsSecrets = (file: string, values: Readonly<Record<string, string>>) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cloud-sops-"))
  try {
    const editor = join(dir, "editor")
    writeFileSync(editor, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(new URL(import.meta.url).pathname)} "$@"\n`)
    chmodSync(editor, 0o700)
    const result = spawnSync("sops", ["edit", resolve(file)], {
      cwd: dirname(resolve(file)),
      stdio: ["inherit", "inherit", "pipe"],
      env: {
        ...sopsEnv(),
        EDITOR: editor,
        SOPS_EDITOR: editor,
        PI_CLOUD_SOPS_VALUES: JSON.stringify(values),
        PI_CLOUD_SOPS_NEW: existsSync(file) ? "" : "1"
      }
    })
    if (result.error !== undefined) throw new Error(`Could not run sops (${result.error.message}); install it, or pass --print`)
    if (result.status !== 0) throw new Error(`sops failed: ${result.stderr.toString().trim()}`)
    chmodSync(file, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.env.PI_CLOUD_SOPS_VALUES !== undefined) {
  const { readFileSync } = await import("node:fs")
  const target = process.argv[2]!
  const current = process.env.PI_CLOUD_SOPS_NEW === "1" ? "" : readFileSync(target, "utf8")
  writeFileSync(target, setYamlKeys(current, JSON.parse(process.env.PI_CLOUD_SOPS_VALUES)))
}
