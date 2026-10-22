import { describe, expect, it } from "vitest"
import { clean } from "../src/setup.ts"

describe("clean", () => {
  it("strips bracketed-paste markers and control characters", () => {
    expect(clean("\u001b[200~sk-ant-api03-abc\u001b[201~")).toBe("sk-ant-api03-abc")
    expect(clean(" ghp_x\u0007y\u007f \t")).toBe("ghp_xy")
    expect(clean("sk-ant-plain")).toBe("sk-ant-plain")
  })
})
