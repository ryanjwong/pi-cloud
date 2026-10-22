import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename, extname } from "node:path"

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file !== "")
const problems: Array<string> = []
const report = (file: string, line: number, message: string) => void problems.push(`${file}:${line}: ${message}`)

const hashComment = (line: string, quotes: ReadonlyArray<string>) => {
  let inside: string | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (inside !== undefined) {
      if (line.startsWith(inside, index) && line[index - 1] !== "\\") {
        index += inside.length - 1
        inside = undefined
      }
      continue
    }
    const opening = quotes.find((quote) => line.startsWith(quote, index))
    if (opening !== undefined) {
      inside = opening
      index += opening.length - 1
      continue
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]!))) return true
  }
  return false
}

const codeComment: Record<string, (line: string) => boolean> = {
  sh: (line) => hashComment(line, ['"', "'"]),
  bash: (line) => hashComment(line, ['"', "'"]),
  yaml: (line) => hashComment(line, ['"', "'"]),
  nix: (line) => hashComment(line, ['"', "''"]) || line.includes("/*"),
  ts: (line) => /(^|[^:"'`])\/\/|\/\*/.test(line),
  js: (line) => /(^|[^:"'`])\/\/|\/\*/.test(line),
  json: (line) => /(^|[^:"'`])\/\/|\/\*/.test(line)
}

for (const file of files) {
  const name = basename(file).toLowerCase()
  if (name === "agents.md" || name === "claude.md") report(file, 1, "AGENTS.md and CLAUDE.md are not allowed.")
  if (extname(file) === ".jsonc") report(file, 1, "Use .json: JSONC exists to allow comments.")
  const kind = name === ".gitignore" ? "sh" : { ".yaml": "yaml", ".yml": "yaml", ".nix": "nix", ".sh": "sh" }[extname(file)]
  const lines = () => readFileSync(file, "utf8").split("\n")
  if (kind !== undefined) {
    lines().forEach((line, index) => {
      if (index === 0 && line.startsWith("#!")) return
      if (codeComment[kind]!(line)) report(file, index + 1, "Comments are not allowed.")
    })
  }
  if (extname(file) === ".md" && file !== "README.md") {
    let fence: string | undefined
    lines().forEach((line, index) => {
      const opening = /^```(\w*)/.exec(line)
      if (opening !== null) {
        fence = fence === undefined ? opening[1] ?? "" : undefined
        return
      }
      if (fence === undefined) {
        if (line.includes("<!--")) report(file, index + 1, "Comments are not allowed.")
        return
      }
      const check = codeComment[fence === "jsonc" ? "json" : fence]
      if (check?.(line) === true) report(file, index + 1, "Comments are not allowed in code blocks.")
    })
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}.`)
  process.exit(1)
}
