import {describe, expect, it, vi} from "vitest"
import type {GitProvider} from "../../src/git/provider.js"

vi.mock("parse-diff", () => ({
  default: vi.fn(() => {
    throw new Error("parse-diff failed")
  }),
}))

import {analyzePatchMergeability} from "../../src/git/merge-analysis.js"

const oid = (c: string) => c.repeat(40)

describe("merge-analysis: parse-diff failure in dry-run merge", () => {
  it("treats parse errors as non-conflicting dry-run merge", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => oid("m")),
      isDescendent: vi.fn(async () => false),
      readBlob: vi.fn(async () => ({blob: "x"})),
    } as unknown as GitProvider

    const res = await analyzePatchMergeability(
      git,
      "/r",
      {
        id: "p",
        commits: [{oid: c1, message: "m", author: {name: "n", email: "e"}}],
        baseBranch: "main",
        raw: {content: "diff --git a/x b/x\n"},
      } as any,
      "main",
    )
    expect(res.analysis).toBe("clean")
    expect(res.hasConflicts).toBe(false)
  })
})
