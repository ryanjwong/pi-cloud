import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { setYamlKeys, writeSopsSecrets } from "../src/sops.ts"

const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef==\n-----END RSA PRIVATE KEY-----\n"

describe("setYamlKeys", () => {
  it("replaces entries with their continuation lines and keeps everything else", () => {
    const before = [
      "# comment",
      "ANTHROPIC_API_KEY: sk-ant",
      "GITHUB_APP_PRIVATE_KEY: |",
      "  old",
      "  key",
      "",
      "GITHUB_APP_ID: \"1\"",
      "SLACK_BOT_TOKEN: xoxb",
      ""
    ].join("\n")
    expect(setYamlKeys(before, { GITHUB_APP_ID: "77", GITHUB_APP_PRIVATE_KEY: key })).toBe([
      "# comment",
      "ANTHROPIC_API_KEY: sk-ant",
      "SLACK_BOT_TOKEN: xoxb",
      "",
      "GITHUB_APP_ID: \"77\"",
      "GITHUB_APP_PRIVATE_KEY: |",
      "  -----BEGIN RSA PRIVATE KEY-----",
      "  MIIabc",
      "  def==",
      "  -----END RSA PRIVATE KEY-----",
      ""
    ].join("\n"))
    expect(setYamlKeys("", { A: "b" })).toBe("A: \"b\"\n")
  })
})

const hasSops = spawnSync("sops", ["--version"]).status === 0 && spawnSync("age-keygen", ["--help"]).error === undefined

describe.skipIf(!hasSops)("writeSopsSecrets", () => {
  it("encrypts the values into a new or existing SOPS file without leaving plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cloud-sops-test-"))
    try {
      const identity = join(dir, "key.txt")
      execFileSync("age-keygen", ["-o", identity], { stdio: "ignore" })
      const recipient = readFileSync(identity, "utf8").match(/public key: (age1\w+)/)![1]!
      writeFileSync(join(dir, ".sops.yaml"), `creation_rules:\n  - path_regex: .*\\.yaml$\n    age: ${recipient}\n`)
      const env = { ...process.env, SOPS_AGE_KEY_FILE: identity }
      const file = join(dir, "secrets.yaml")
      const decrypt = () => execFileSync("sops", ["decrypt", file], { cwd: dir, env, encoding: "utf8" })
      const cwd = process.cwd()
      process.chdir(dir)
      Object.assign(process.env, { SOPS_AGE_KEY_FILE: identity })
      try {
        // A new file holds only the given keys (none of SOPS's example document).
        writeSopsSecrets(file, { GITHUB_APP_ID: "77", GITHUB_APP_PRIVATE_KEY: key })
        expect(readFileSync(file, "utf8")).not.toContain("MIIabc")
        expect(decrypt()).toBe(`GITHUB_APP_ID: "77"\nGITHUB_APP_PRIVATE_KEY: |\n    -----BEGIN RSA PRIVATE KEY-----\n    MIIabc\n    def==\n    -----END RSA PRIVATE KEY-----\n`)

        // An existing file keeps its other secrets.
        writeSopsSecrets(file, { GITHUB_WEBHOOK_SECRET: "whsec", GITHUB_APP_ID: "78" })
        const after = decrypt()
        expect(after).toContain('GITHUB_APP_ID: "78"')
        expect(after).toContain("MIIabc")
        expect(after).toContain("GITHUB_WEBHOOK_SECRET: whsec")
      } finally {
        process.chdir(cwd)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
