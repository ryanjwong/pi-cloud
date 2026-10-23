import type { Context } from "@earendil-works/chord"
import {
  type BinaryReader,
  type DirReader,
  err,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  LineScanner,
  ok,
  type Result,
  StreamDecoder,
  type TextLineReader,
  type WatchChange,
  type WatchTarget
} from "@earendil-works/pi-durable/env"
import { posix } from "node:path"

export interface RemoteShell {
  readonly id: string
  readonly stdin?: boolean
  run(script: string, options: RemoteRunOptions): Promise<number>
  writeFile?(path: string, content: Uint8Array, signal: AbortSignal | undefined): Promise<void>
  close?(): Promise<void>
}

export interface RemoteRunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: Uint8Array
  readonly signal?: AbortSignal
  readonly onStdout?: (chunk: Uint8Array | string) => void
  readonly onStderr?: (chunk: Uint8Array | string) => void
}

export interface ShellEnvOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly watchIntervalMs?: number
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const encoder = new TextEncoder()
const bytesOf = (chunk: Uint8Array | string) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk)

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let position = 0
  for (const chunk of chunks) {
    bytes.set(chunk, position)
    position += chunk.length
  }
  return bytes
}

const fromBase64 = (text: string) => {
  const binary = atob(text.replace(/\s+/g, ""))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const FAILURES: Record<number, FileErrorCode> = {
  2: "not_found",
  3: "is_directory",
  4: "not_directory",
  5: "permission_denied",
  6: "invalid"
}

const PRELUDE = `m() { a=$(dirname -- "$1"); while [ ! -e "$a" ] && [ "$a" != / ] && [ "$a" != . ]; do a=$(dirname -- "$a"); done
  [ -e "$a" ] && [ ! -d "$a" ] && exit 4; exit 2; }
e() { [ -e "$1" ] || [ -L "$1" ] || m "$1"; }
p() { d=$(dirname -- "$1"); [ -e "$d" ] || m "$d"; [ -d "$d" ] || exit 4; }
`

const STAT = `st() { stat -c '%F|%s|%.3Y|%n' -- "$@" 2>/dev/null || stat -c '%F|%s|%Y|%n' -- "$@"; }
`

const KINDS: Record<string, FileKind> = {
  "regular file": "file",
  "regular empty file": "file",
  directory: "directory",
  "symbolic link": "symlink"
}

const NO_CWD = 199
const NO_PROGRAM = 198
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const WRITE_CHUNK = 48 * 1024
const MAX_TIMEOUT_MS = 2_147_483_647
const DETACHED = {} as Context

export const shellEnv = (shell: RemoteShell, options: ShellEnvOptions): ExecutionEnv => {
  const baseEnv = options.env ?? {}
  const active = new Set<string>()
  let home: Promise<string> | undefined

  const resolvePath = (cwd: string, path: string, homeDir: string) => {
    let normalized = path
    if (normalized === "~") normalized = homeDir
    else if (normalized.startsWith("~/")) normalized = posix.join(homeDir, normalized.slice(2))
    else if (normalized.startsWith("file://")) {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname)
      } catch {
      }
    }
    return posix.isAbsolute(normalized) ? posix.resolve(normalized) : posix.resolve(cwd, normalized)
  }

  const capture = async (
    script: string,
    args: ReadonlyArray<string>,
    signal?: AbortSignal,
    stdin?: Uint8Array
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }> => {
    const stdout: Array<Uint8Array> = []
    let stderr = ""
    const code = await shell.run(`set -- ${args.map(quote).join(" ")}\n${script}`, {
      env: baseEnv,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
      onStdout: (chunk) => stdout.push(bytesOf(chunk)),
      onStderr: (chunk) => (stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    })
    return { code, stdout: concat(stdout), stderr }
  }

  const absolute = async (path: string) => resolvePath(env.cwd, path, await homeDir())

  const homeDir = () => {
    home ??= capture(`printf %s "$HOME"`, [])
      .then(({ stdout }) => new TextDecoder().decode(stdout) || "/")
      .catch(() => {
        home = undefined
        return "/"
      })
    return home
  }

  const aborted = (context: Context, path?: string) =>
    context.abortSignal?.aborted ? err<never, FileError>(new FileError("aborted", "aborted", path)) : undefined

  const fileOp = async (
    script: string,
    path: string,
    args: ReadonlyArray<string>,
    context: Context,
    stdin?: Uint8Array
  ): Promise<Result<Uint8Array, FileError>> => {
    const early = aborted(context, path)
    if (early) return early
    try {
      const { code, stdout, stderr } = await capture(PRELUDE + script, args, context.abortSignal, stdin)
      if (code === 0) return ok(stdout)
      const failure = FAILURES[code]
      if (failure !== undefined) return err(new FileError(failure, `${failure}: ${path}`, path))
      return err(new FileError("unknown", stderr.trim() || `Command exited with ${code}`, path))
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path))
      const cause = error instanceof Error ? error : new Error(String(error))
      return err(error instanceof FileError ? error : new FileError("unknown", cause.message, path, cause))
    }
  }

  const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)

  const parseStat = (line: string, directory?: string): FileInfo | undefined => {
    const [kind, size, mtime, ...rest] = line.split("|")
    const name = rest.join("|")
    const fileKind = KINDS[kind ?? ""]
    if (fileKind === undefined || name === "") return undefined
    const path = directory === undefined ? name : posix.join(directory, name)
    return { name: posix.basename(path), path, kind: fileKind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) }
  }

  const fileInfo = async (path: string, context: Context): Promise<Result<FileInfo, FileError>> => {
    const resolved = await absolute(path)
    const result = await fileOp(`${STAT}e "$1"; st "$1"`, resolved, [resolved], context)
    if (!result.ok) return result
    const info = parseStat(text(result.value).trimEnd())
    return info === undefined ? err(new FileError("invalid", "Unsupported file type", resolved)) : ok({ ...info, path: resolved })
  }

  const listDir = async (path: string, context: Context): Promise<Result<Array<FileInfo>, FileError>> => {
    const resolved = await absolute(path)
    const script = `${STAT}e "$1"; [ -d "$1" ] || exit 4; cd -- "$1" || exit 5
set --
for f in * .*; do
  case "$f" in .|..) continue ;; esac
  if [ -e "$f" ] || [ -L "$f" ]; then set -- "$@" "$f"; fi
done
[ $# -eq 0 ] || st "$@"`
    const result = await fileOp(script, resolved, [resolved], context)
    if (!result.ok) return result
    return ok(text(result.value).split("\n").flatMap((line) => parseStat(line, resolved) ?? []))
  }

  const readBinaryFile = async (path: string, context: Context): Promise<Result<Uint8Array, FileError>> => {
    const resolved = await absolute(path)
    const result = await fileOp(
      `e "$1"; [ -d "$1" ] && exit 3; [ -r "$1" ] || exit 5; base64 < "$1"`,
      resolved,
      [resolved],
      context
    )
    return result.ok ? ok(fromBase64(text(result.value))) : result
  }

  const put = async (
    path: string,
    content: string | Uint8Array,
    append: boolean,
    context: Context
  ): Promise<Result<void, FileError>> => {
    const resolved = await absolute(path)
    const bytes = typeof content === "string" ? encoder.encode(content) : content
    const check = `mkdir -p -- "$(dirname -- "$1")" || exit 4; [ -d "$1" ] && exit 3; `
    if (!append && shell.writeFile !== undefined) {
      const checked = await fileOp(check + "exit 0", resolved, [resolved], context)
      if (!checked.ok) return checked
      try {
        await shell.writeFile(resolved, bytes, context.abortSignal)
        return ok(undefined)
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error))
        return err(error instanceof FileError ? error : new FileError("unknown", cause.message, resolved, cause))
      }
    }
    if (shell.stdin === true) {
      const result = await fileOp(`${check}cat ${append ? ">>" : ">"} "$1"`, resolved, [resolved], context, bytes)
      return result.ok ? ok(undefined) : result
    }
    const encoded = toBase64(bytes)
    for (let offset = 0; offset === 0 || offset < encoded.length; offset += WRITE_CHUNK) {
      const redirect = append || offset > 0 ? ">>" : ">"
      const chunk = encoded.slice(offset, offset + WRITE_CHUNK)
      const result = await fileOp(`${check}printf %s "$2" | base64 -d ${redirect} "$1"`, resolved, [resolved, chunk], context)
      if (!result.ok) return result
    }
    return ok(undefined)
  }

  const createTempDir = async (prefix: string | undefined, context: Context): Promise<Result<string, FileError>> => {
    const result = await fileOp(`mktemp -d "\${TMPDIR:-/tmp}/$1XXXXXX"`, "", [prefix ?? "tmp-"], context)
    return result.ok ? ok(text(result.value).trim()) : result
  }

  const kill = (pidFile: string) =>
    capture(
      `[ -f "$1" ] || exit 0
pid=$(cat "$1"); rm -f "$1"
[ -n "$pid" ] || exit 0
kill -9 -"$pid" 2>/dev/null
k() {
  for d in /proc/[0-9]*; do
    [ "$(sed -n 's/^PPid:[[:space:]]*//p' "$d/status" 2>/dev/null)" = "$1" ] && k "\${d#/proc/}"
  done
  kill -9 "$1" 2>/dev/null
}
k "$pid"
exit 0`,
      [pidFile]
    ).catch(() => undefined)

  const exec: ExecutionEnv["exec"] = async (command, execOptions, context) => {
    const signal = context.abortSignal
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"))
    const timeout = execOptions?.timeout
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"))
    }
    if (timeout !== undefined && timeout * 1000 > MAX_TIMEOUT_MS) {
      return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`))
    }
    if (typeof command !== "string" && command.length === 0) {
      return err(new ExecutionError("spawn_error", "Empty argv: no program to run"))
    }
    const cwd = execOptions?.cwd === undefined ? env.cwd : await absolute(execOptions.cwd)
    const pidFile = `/tmp/.pi-cloud-exec-${crypto.randomUUID()}`
    const program = typeof command === "string" ? `"$R" -c ${quote(command)}` : command.map(quote).join(" ")
    const inner = quote(`echo $$ > "$0"; exec "$@"`)
    const script = `R=sh; command -v bash >/dev/null 2>&1 && R=bash
cd -- ${quote(cwd)} 2>/dev/null || exit ${NO_CWD}
${typeof command === "string" ? "" : `command -v ${quote(command[0]!)} >/dev/null 2>&1 || exit ${NO_PROGRAM}`}
if setsid -w true 2>/dev/null; then setsid -w sh -c ${inner} ${quote(pidFile)} ${program}
else sh -c ${inner} ${quote(pidFile)} ${program}; fi
s=$?; rm -f ${quote(pidFile)}; exit $s`

    const local = new AbortController()
    let interrupted: "timeout" | "aborted" | undefined
    let callbackError: ExecutionError | undefined
    let settled = false
    const interrupt = (reason: "timeout" | "aborted") => {
      if (interrupted !== undefined) return
      interrupted = reason
      void kill(pidFile).then(() => setTimeout(() => !settled && void kill(pidFile), 1_000))
      setTimeout(() => local.abort(), 3_000).unref?.()
    }
    const onAbort = () => interrupt("aborted")
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = timeout === undefined ? undefined : setTimeout(() => interrupt("timeout"), timeout * 1000)

    const spill = execOptions?.spill
    const seen: Array<Uint8Array> = []
    let seenBytes = 0
    let seenNewlines = 0
    let spilling = false
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() }
    const emit = (value: string, stream: "stdout" | "stderr") => {
      if (value === "" || settled || interrupted !== undefined || callbackError !== undefined) return
      try {
        execOptions?.onOutput?.(value, context, { stream })
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error))
        callbackError = new ExecutionError("callback_error", cause.message, cause)
        interrupt("aborted")
      }
    }
    const feed = (stream: "stdout" | "stderr") => (chunk: Uint8Array | string) => {
      emit(typeof chunk === "string" ? chunk : decoders[stream].decode(chunk), stream)
      if (spill === undefined) return
      const bytes = bytesOf(chunk)
      if (bytes.length === 0) return
      if (seenBytes + bytes.length <= MAX_SPILL_BYTES) seen.push(bytes)
      seenBytes += bytes.length
      for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, index + 1)) seenNewlines++
      const lines = seenNewlines + (bytes[bytes.length - 1] === 0x0a ? 0 : 1)
      if (seenBytes > spill.afterBytes || lines > spill.afterLines) spilling = true
    }

    active.add(pidFile)
    let exitCode: number
    try {
      exitCode = await shell.run(script, {
        env: { ...baseEnv, ...execOptions?.env },
        signal: local.signal,
        onStdout: feed("stdout"),
        onStderr: feed("stderr")
      })
    } catch (error) {
      exitCode = -1
      if (interrupted === undefined && callbackError === undefined) {
        const cause = error instanceof Error ? error : new Error(String(error))
        settled = true
        return err(new ExecutionError("spawn_error", cause.message, cause))
      }
    } finally {
      active.delete(pidFile)
      signal?.removeEventListener("abort", onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
    emit(decoders.stdout.decode(), "stdout")
    emit(decoders.stderr.decode(), "stderr")
    settled = true

    let spillPath: string | undefined
    if (spilling) {
      const created = await createTempDir("pi-output-", DETACHED)
      if (created.ok) {
        const path = posix.join(created.value, `pi-output-${crypto.randomUUID()}.log`)
        const written = await put(path, concat(seen), false, DETACHED)
        if (written.ok) spillPath = path
      }
    }
    if (callbackError !== undefined) return err(callbackError)
    if (interrupted !== undefined) {
      const error = interrupted === "timeout"
        ? new ExecutionError("timeout", `timeout:${timeout}`)
        : new ExecutionError("aborted", "aborted")
      if (spillPath !== undefined) error.spillPath = spillPath
      return err(error)
    }
    if (exitCode === NO_PROGRAM && typeof command !== "string") {
      const found = await capture(`cd -- "$1" && command -v "$2" >/dev/null 2>&1`, [cwd, command[0]!]).catch(() => undefined)
      if (found !== undefined && found.code !== 0) return err(new ExecutionError("spawn_error", `spawn ${command[0]} ENOENT`))
    }
    if (exitCode === NO_CWD) {
      const exists = await capture(`[ -d "$1" ]`, [cwd]).catch(() => undefined)
      if (exists !== undefined && exists.code !== 0) {
        return err(new ExecutionError("spawn_error", `Working directory does not exist: ${cwd}\nCannot execute bash commands.`))
      }
    }
    return ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) })
  }

  const openBinaryReader: ExecutionEnv["openBinaryReader"] = async (path, readerOptions, context) => {
    const resolved = await absolute(path)
    const info = await fileInfo(resolved, context)
    if (!info.ok) return info
    if (info.value.kind === "symlink") {
      if (readerOptions?.noFollow === true) {
        return err(new FileError("invalid", "Refusing to follow a symbolic link", resolved))
      }
      const target = await env.canonicalPath(resolved, context)
      if (!target.ok) return target
      return openBinaryReader(target.value, readerOptions, context)
    }
    if (info.value.kind === "directory") {
      return err(new FileError("is_directory", "EISDIR: illegal operation on a directory, read", resolved))
    }
    const content = await readBinaryFile(resolved, context)
    if (!content.ok) return content
    return ok(memoryReader(resolved, { ...info.value, size: content.value.length }, content.value))
  }

  const env: ExecutionEnv = {
    id: shell.id,
    cwd: options.cwd,
    absolutePath: async (path) => ok(await absolute(path)),
    joinPath: async (parts) => ok(posix.join(...parts)),
    readTextFile: async (path, context) => {
      const result = await readBinaryFile(path, context)
      return result.ok ? ok(text(result.value)) : result
    },
    openTextLineReader: async (path, context) => {
      const resolved = await absolute(path)
      const result = await readBinaryFile(resolved, context)
      return result.ok ? ok(lineReader(resolved, result.value)) : result
    },
    readTextLines: async (path, lineOptions, context) => {
      if (lineOptions?.maxLines !== undefined && lineOptions.maxLines <= 0) return ok([])
      const opened = await env.openTextLineReader(path, context)
      if (!opened.ok) return opened
      const lines: Array<string> = []
      while (lineOptions?.maxLines === undefined || lines.length < lineOptions.maxLines) {
        const line = await opened.value.readLine(context)
        if (!line.ok) return line
        if (line.value === undefined) break
        lines.push(line.value.text)
      }
      return ok(lines)
    },
    readBinaryFile,
    openBinaryReader,
    writeFile: (path, content, context) => put(path, content, false, context),
    appendFile: (path, content, context) => put(path, content, true, context),
    truncateFile: async (path, size, context) => {
      const resolved = await absolute(path)
      const result = await fileOp(`e "$1"; [ -d "$1" ] && exit 3; truncate -s "$2" -- "$1"`, resolved, [resolved, String(size)], context)
      return result.ok ? ok(undefined) : result
    },
    flushFile: async (path, context) => {
      const resolved = await absolute(path)
      const result = await fileOp(`e "$1"; sync`, resolved, [resolved], context)
      return result.ok ? ok(undefined) : result
    },
    renameFile: async (source, destination, context) => {
      const from = await absolute(source)
      const to = await absolute(destination)
      const result = await fileOp(
        `p "$1"; p "$2"; e "$1"; if [ -d "$2" ] && [ ! -d "$1" ]; then exit 3; fi; [ "$1" = "$2" ] || mv -f -- "$1" "$2"`,
        from,
        [from, to],
        context
      )
      return result.ok ? ok(undefined) : result
    },
    fileInfo,
    listDir,
    openDirReader: async (path, context) => {
      const resolved = await absolute(path)
      const info = await fileInfo(resolved, context)
      if (!info.ok) return info
      if (info.value.kind !== "directory") return err(new FileError("not_directory", `not_directory: ${resolved}`, resolved))
      return ok(dirReader(resolved, (readContext) => listDir(resolved, readContext)))
    },
    watch: (targets, onChange, context) =>
      pollingWatch(targets, onChange, context, {
        intervalMs: options.watchIntervalMs ?? 1_000,
        resolve: absolute,
        snapshot: (script, args) => capture(script, args).then(({ code, stdout, stderr }) => ({ code, stdout: text(stdout), stderr }))
      }),
    canonicalPath: async (path, context) => {
      const resolved = await absolute(path)
      const result = await fileOp(`e "$1"; realpath -- "$1" 2>/dev/null || readlink -f -- "$1"`, resolved, [resolved], context)
      return result.ok ? ok(text(result.value).replace(/\n$/, "")) : result
    },
    exists: async (path, context) => {
      const result = await fileInfo(path, context)
      if (result.ok) return ok(true)
      return result.error.code === "not_found" ? ok(false) : err(result.error)
    },
    createDir: async (path, dirOptions, context) => {
      const resolved = await absolute(path)
      const script = (dirOptions?.recursive ?? true)
        ? `mkdir -p -- "$1" 2>/dev/null && exit 0; [ -e "$1" ] || m "$1"; exit 1`
        : `p "$1"; mkdir -- "$1"`
      const result = await fileOp(script, resolved, [resolved], context)
      return result.ok ? ok(undefined) : result
    },
    remove: async (path, removeOptions, context) => {
      const resolved = await absolute(path)
      const script = `if [ ! -e "$1" ] && [ ! -L "$1" ]; then (m "$1"); c=$?; [ $c = 2 ] && [ "$2" = f ] && exit 0; exit $c; fi
if [ -d "$1" ] && [ ! -L "$1" ]; then [ "$3" = r ] || exit 3; rm -rf -- "$1"; else rm -f -- "$1"; fi`
      const args = [resolved, removeOptions?.force === true ? "f" : "", removeOptions?.recursive === true ? "r" : ""]
      const result = await fileOp(script, resolved, args, context)
      return result.ok ? ok(undefined) : result
    },
    createTempDir,
    createTempFile: async (fileOptions, context) => {
      const dir = await createTempDir("tmp-", context)
      if (!dir.ok) return dir
      const path = posix.join(dir.value, `${fileOptions?.prefix ?? ""}${crypto.randomUUID()}${fileOptions?.suffix ?? ""}`)
      const written = await put(path, "", false, context)
      return written.ok ? ok(path) : written
    },
    exec,
    cleanup: async () => {
      const running = [...active]
      active.clear()
      await Promise.allSettled(running.map(kill))
      await shell.close?.()
    }
  }
  return env
}

const closed = (what: string, path: string) => err<never, FileError>(new FileError("invalid", `${what} is closed`, path))

const lineReader = (path: string, bytes: Uint8Array): TextLineReader => {
  const decoder = new StreamDecoder()
  let buffered = decoder.decode(bytes) + decoder.decode()
  let isClosed = false
  return {
    readLine: async () => {
      if (isClosed) return closed("Text line reader", path)
      const newline = buffered.indexOf("\n")
      if (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        return ok({ text: line, terminated: true })
      }
      if (buffered.length === 0) return ok(undefined)
      const line = buffered
      buffered = ""
      return ok({ text: line, terminated: false })
    },
    close: async () => void (isClosed = true)
  }
}

const abortedAt = (context: Context, path: string) =>
  context.abortSignal?.aborted ? err<never, FileError>(new FileError("aborted", "aborted", path)) : undefined

const count = (value: number) => Number.isSafeInteger(value) && value >= 0

const memoryReader = (path: string, info: FileInfo, bytes: Uint8Array): BinaryReader => {
  let isClosed = false
  return {
    info: async (context) => (isClosed ? closed("Binary reader", path) : abortedAt(context, path) ?? ok(info)),
    read: async (offset, length, context) => {
      if (isClosed) return closed("Binary reader", path)
      if (!count(offset) || !count(length)) return err(new FileError("invalid", "Invalid byte range", path))
      return abortedAt(context, path) ?? ok(bytes.slice(offset, offset + length))
    },
    scanLines: async (range, context) => {
      if (isClosed) return closed("Binary reader", path)
      const aborted = abortedAt(context, path)
      if (aborted) return aborted
      let scanner: LineScanner
      try {
        scanner = new LineScanner(range.startLine, range.endLine)
      } catch {
        return err(new FileError("invalid", "Invalid line range", path))
      }
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) scanner.push(bytes.subarray(offset, offset + 64 * 1024))
      return ok(scanner.finish())
    },
    close: async () => void (isClosed = true)
  }
}

const dirReader = (path: string, list: (context: Context) => Promise<Result<Array<FileInfo>, FileError>>): DirReader => {
  let entries: Array<FileInfo> | undefined
  let position = 0
  let isClosed = false
  return {
    next: async (maxEntries, context) => {
      if (isClosed) return closed("Directory reader", path)
      if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "Invalid page size", path))
      const aborted = abortedAt(context, path)
      if (aborted) return aborted
      if (entries === undefined) {
        const listed = await list(context)
        if (!listed.ok) return listed
        entries = listed.value
      }
      const page = entries.slice(position, position + maxEntries)
      position += page.length
      return ok({ entries: page, done: position >= entries.length })
    },
    close: async () => void (isClosed = true)
  }
}

const pollingWatch = async (
  targets: ReadonlyArray<WatchTarget>,
  onChange: (change: WatchChange) => void,
  context: Context,
  options: {
    readonly intervalMs: number
    readonly resolve: (path: string) => Promise<string>
    readonly snapshot: (script: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>
  }
): Promise<Result<FileWatcher, FileError>> => {
  const aborted = abortedAt(context, targets[0]?.path ?? "")
  if (aborted) return aborted
  const resolved = await Promise.all(targets.map(async (target) => ({ ...target, path: await options.resolve(target.path) })))
  const parts = resolved.map((target, index) => {
    const prune = [...(target.exclude?.hidden === true ? [`-name '.*'`] : []), ...(target.exclude?.names ?? []).map((name) => `-name ${quote(name)}`)]
    const depth = target.recursive === true ? "" : "-maxdepth 1"
    const pruning = prune.length === 0 ? "" : `\\( ${prune.join(" -o ")} \\) -prune -o`
    return `t="$${index + 1}"; if [ -e "$t" ] || [ -L "$t" ]; then stat -L -c "$S" -- "$t" 2>/dev/null || stat -c "$S" -- "$t"
  [ -d "$t" ] && find "$t" -mindepth 1 ${depth} ${pruning} -exec stat -c "$S" -- {} + 2>/dev/null; fi`
  })
  const script = [`S='%F|%s|%.9Y|%i|%n'; stat -c "$S" / >/dev/null 2>&1 || S='%F|%s|%Y|%i|%n'`, ...parts, "exit 0"].join("\n")
  const LIMIT = 50_000
  const take = async (): Promise<Map<string, string> | FileError> => {
    const { code, stdout, stderr } = await options.snapshot(script, resolved.map((target) => target.path))
    if (code !== 0) return new FileError("unknown", stderr.trim() || `Snapshot exited with ${code}`)
    const lines = stdout.split("\n").filter(Boolean)
    if (lines.length > LIMIT) return new FileError("invalid", `More than ${LIMIT} watched entries`)
    const snapshot = new Map<string, string>()
    for (const line of lines) {
      const parts = line.split("|")
      snapshot.set(parts.slice(4).join("|"), parts.slice(0, 4).join("|"))
    }
    return snapshot
  }
  let previous = await take().catch((error: unknown) => new FileError("unknown", String(error)))
  if (previous instanceof FileError) return err(previous)

  let isClosed = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    if (isClosed) return
    const next = await take().catch((error: unknown) => new FileError("unknown", String(error)))
    if (isClosed) return
    if (next instanceof FileError) {
      if (++failures >= 3) {
        isClosed = true
        return onChange({ error: next })
      }
    } else {
      if (failures > 0) onChange({ overflow: true })
      failures = 0
      const changed: Array<string> = []
      for (const [path, line] of next) if ((previous as Map<string, string>).get(path) !== line) changed.push(path)
      for (const path of (previous as Map<string, string>).keys()) if (!next.has(path)) changed.push(path)
      previous = next
      if (changed.length > 0) onChange({ paths: changed })
    }
    timer = setTimeout(() => void poll(), options.intervalMs)
    timer.unref?.()
  }
  timer = setTimeout(() => void poll(), options.intervalMs)
  timer.unref?.()
  return ok({
    mode: "polling",
    close: async () => {
      isClosed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  })
}
