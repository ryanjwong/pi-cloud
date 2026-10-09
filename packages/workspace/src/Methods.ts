/** `ExecutionEnv` methods a workspace serves. `cleanup` stays with the client, which owns the processes. */
export const ENV_METHODS = [
  "absolutePath",
  "joinPath",
  "readTextFile",
  "openTextLineReader",
  "readTextLines",
  "readBinaryFile",
  "openBinaryReader",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "openDirReader",
  "watch",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
  "exec"
] as const

/** Methods of the handles those return: line, binary and directory readers, and watchers. */
export const HANDLE_METHODS = ["readLine", "info", "read", "scanLines", "next", "close"] as const

export const isServed = (method: string, onHandle: boolean) =>
  (onHandle ? HANDLE_METHODS : ENV_METHODS as ReadonlyArray<string>).includes(method as never)
