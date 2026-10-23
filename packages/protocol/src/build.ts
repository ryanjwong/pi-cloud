import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const sha = process.env.PI_CLOUD_BUILD === undefined && existsSync(resolve(root, ".git"))
  ? spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim()
  : undefined
if (sha) process.env.PI_CLOUD_BUILD = sha
