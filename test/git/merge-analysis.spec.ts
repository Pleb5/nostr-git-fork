import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import type {GitProvider} from "../../src/git/provider.js"

const {withUrlFallbackMock} = vi.hoisted(() => ({
  withUrlFallbackMock: vi.fn(),
}))

vi.mock("../../src/utils/clone-url-fallback.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../../src/utils/clone-url-fallback.js")>()
  return {...orig, withUrlFallback: withUrlFallbackMock}
})

import {
  analyzePatchMergeability,
  analyzePRMergeability,
  buildConflictMetadataEventFromAnalysis,
  buildMergeMetadataEventFromAnalysis,
  getCommitsAheadOfTipData,
  getMergeBaseBetween,
  getMergeStatusMessage,
  getPRPreviewData,
  type MergeAnalysisResult,
} from "../../src/git/merge-analysis.js"

const oid = (c: string) => c.repeat(40)

const baseResult = (): MergeAnalysisResult => ({
  canMerge: false,
  hasConflicts: false,
  conflictFiles: [],
  conflictDetails: [],
  upToDate: false,
  fastForward: false,
  patchCommits: [],
  analysis: "clean",
})

describe("merge-analysis: metadata builders", () => {
  it("buildMergeMetadataEventFromAnalysis maps ff, conflict, and clean outcomes", () => {
    const repoAddr = "30617:abc:repo"
    const rootId = "root1"
    const r = (over: Partial<MergeAnalysisResult>) => ({...baseResult(), ...over})

    const ff = buildMergeMetadataEventFromAnalysis({
      repoAddr,
      rootId,
      targetBranch: "main",
      baseBranch: "develop",
      result: r({fastForward: true, canMerge: true, analysis: "clean"}),
    })
    expect(ff.tags.some((t: string[]) => t[0] === "result" && t[1] === "ff")).toBe(true)

    const conflict = buildMergeMetadataEventFromAnalysis({
      repoAddr,
      rootId,
      targetBranch: "main",
      result: r({hasConflicts: true, canMerge: false, analysis: "conflicts"}),
    })
    expect(conflict.tags.some((t: string[]) => t[0] === "result" && t[1] === "conflict")).toBe(true)

    const clean = buildMergeMetadataEventFromAnalysis({
      repoAddr,
      rootId,
      targetBranch: "main",
      result: r({canMerge: true, fastForward: false, analysis: "clean"}),
    })
    expect(clean.tags.some((t: string[]) => t[0] === "result" && t[1] === "clean")).toBe(true)
    expect(JSON.parse(clean.content).canMerge).toBe(true)
  })

  it("buildConflictMetadataEventFromAnalysis returns undefined when no conflicts or no files", () => {
    expect(
      buildConflictMetadataEventFromAnalysis({
        repoAddr: "30617:a:r",
        rootId: "r",
        result: {...baseResult(), hasConflicts: true, conflictFiles: []},
      }),
    ).toBeUndefined()
    expect(
      buildConflictMetadataEventFromAnalysis({
        repoAddr: "30617:a:r",
        rootId: "r",
        result: {...baseResult(), hasConflicts: false, conflictFiles: ["a.txt"]},
      }),
    ).toBeUndefined()
  })

  it("buildConflictMetadataEventFromAnalysis builds event when conflicts and files present", () => {
    const ev = buildConflictMetadataEventFromAnalysis({
      repoAddr: "30617:a:r",
      rootId: "r",
      result: {
        ...baseResult(),
        hasConflicts: true,
        conflictFiles: ["x.ts"],
        conflictDetails: [{file: "x.ts", type: "content", conflictMarkers: []}],
      },
    })
    expect(ev).toBeDefined()
    expect(ev!.tags.some((t: string[]) => t[0] === "file" && t[1] === "x.ts")).toBe(true)
    expect(JSON.parse(ev!.content).details).toHaveLength(1)
  })
})

describe("merge-analysis: getMergeStatusMessage", () => {
  it("covers analysis variants and default branch", () => {
    const r = (over: Partial<MergeAnalysisResult>) => ({...baseResult(), ...over})
    expect(getMergeStatusMessage(r({analysis: "clean", fastForward: true}))).toContain("fast-forward")
    expect(getMergeStatusMessage(r({analysis: "clean", fastForward: false}))).toContain("cleanly")
    expect(getMergeStatusMessage(r({analysis: "conflicts", conflictFiles: ["a", "b"]}))).toContain(
      "2 file",
    )
    expect(getMergeStatusMessage(r({analysis: "up-to-date"}))).toContain("already been applied")
    expect(getMergeStatusMessage(r({analysis: "diverged"}))).toContain("diverged")
    expect(getMergeStatusMessage(r({analysis: "error", errorMessage: "boom"}))).toContain("boom")
    expect(getMergeStatusMessage(r({analysis: "error"}))).toContain("Unknown error")
    expect(
      getMergeStatusMessage({...r({analysis: "clean"}), analysis: "unknown" as any}),
    ).toContain("pending")
  })
})

describe("merge-analysis: getMergeBaseBetween", () => {
  it("resolves target via ordered refs and returns merge base", async () => {
    const head = oid("a")
    const target = oid("b")
    const base = oid("c")
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/main" || ref === "main") return target
        throw new Error("no")
      }),
      findMergeBase: vi.fn(async () => base),
    } as unknown as GitProvider

    const out = await getMergeBaseBetween(git, "/r", head, "main")
    expect(out.mergeBase).toBe(base)
    expect(out.error).toBeUndefined()
  })

  it("returns error when target branch cannot be resolved", async () => {
    const git = {
      resolveRef: vi.fn(async () => {
        throw new Error("missing")
      }),
    } as unknown as GitProvider
    const out = await getMergeBaseBetween(git, "/r", oid("a"), "gone")
    expect(out.mergeBase).toBeUndefined()
    expect(out.error).toContain("not found")
  })

  it("prefers sourceRemote refs when provided", async () => {
    const head = oid("1")
    const target = oid("2")
    const base = oid("3")
    let sawFork = false
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/remotes/fork/main") {
          sawFork = true
          return target
        }
        throw new Error("skip")
      }),
      findMergeBase: vi.fn(async () => base),
    } as unknown as GitProvider

    const out = await getMergeBaseBetween(git, "/r", head, "main", {sourceRemote: "fork"})
    expect(sawFork).toBe(true)
    expect(out.mergeBase).toBe(base)
  })

  it("normalizes findMergeBase when git returns an array of oids", async () => {
    const head = oid("1")
    const target = oid("2")
    const firstBase = oid("9")
    const git = {
      resolveRef: vi.fn(async () => target),
      findMergeBase: vi.fn(async () => [firstBase, oid("8")]),
    } as unknown as GitProvider
    const out = await getMergeBaseBetween(git, "/r", head, "main")
    expect(out.mergeBase).toBe(firstBase)
  })
})

describe("merge-analysis: getPRPreviewData", () => {
  it("returns success with commits and files when branches differ", async () => {
    const source = oid("a")
    const target = oid("b")
    const mergeBase = oid("c")
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("feature")) return source
        if (ref.includes("main") || ref === "refs/heads/main") return target
        throw new Error(`unexpected ${ref}`)
      }),
      findMergeBase: vi.fn(async () => mergeBase),
      log: vi.fn(async () => [
        {oid: source, commit: {message: "tip", author: {name: "n", email: "e"}}},
        {oid: mergeBase, commit: {message: "base"}},
      ]),
      walk: vi.fn(async () => []),
    } as unknown as GitProvider

    const res = await getPRPreviewData(git, "/repo", "feature", "main", {preferRemoteRefs: false})
    expect(res.success).toBe(true)
    expect(res.mergeBase).toBe(mergeBase)
    expect(res.tipCommit).toBe(source)
    expect(res.commits).toHaveLength(1)
    expect(res.commitOids).toEqual([source])
  })

  it("returns error when target branch is missing", async () => {
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/feature") return oid("a")
        throw new Error("nope")
      }),
    } as unknown as GitProvider
    const res = await getPRPreviewData(git, "/r", "feature", "missing")
    expect(res.success).toBe(false)
    expect(res.error).toContain('Target branch "missing" not found')
  })

  it("returns success with empty commits when log fails for source ref", async () => {
    const source = oid("1")
    const target = oid("2")
    const base = oid("3")
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("feature")) return source
        if (ref.includes("main")) return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => base),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === source) throw new Error("log failed")
        return []
      }),
      walk: vi.fn(async () => []),
    } as unknown as GitProvider
    const res = await getPRPreviewData(git, "/r", "feature", "main")
    expect(res.success).toBe(true)
    expect(res.commits).toEqual([])
    expect(res.commitOids).toEqual([])
  })

  it("tries origin remote refs first when preferRemoteRefs is true", async () => {
    const source = oid("1")
    const target = oid("2")
    const base = oid("3")
    const calls: string[] = []
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        calls.push(ref)
        if (ref === "refs/remotes/origin/feature") return source
        if (ref === "refs/heads/feature") throw new Error("skip")
        if (ref.endsWith("/main") || ref === "main") return target
        throw new Error("missing")
      }),
      findMergeBase: vi.fn(async () => base),
      log: vi.fn(async () => [{oid: source, commit: {message: "m"}}]),
      walk: vi.fn(async () => []),
    } as unknown as GitProvider

    const res = await getPRPreviewData(git, "/r", "feature", "main", {preferRemoteRefs: true})
    expect(res.success).toBe(true)
    expect(calls[0]).toBe("refs/remotes/origin/feature")
  })

  it("lists changed files via walk when TREE is available", async () => {
    const source = oid("1")
    const target = oid("2")
    const base = oid("3")
    const treeMock = vi.fn(({ref}: {ref: string}) => ({ref, kind: "tree"}))
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("feature")) return source
        if (ref.includes("main")) return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => base),
      log: vi.fn(async () => [{oid: source, commit: {message: "m"}}]),
      TREE: treeMock,
      walk: vi.fn(async ({map}: {map: (fp: string, pair: any[]) => Promise<unknown>}) => {
        const A = {type: async () => "blob", oid: async () => "aaa"}
        const B = {type: async () => "blob", oid: async () => "bbb"}
        const changed = await map("src/changed.ts", [A, B])
        const same = await map("README.md", [
          {type: async () => "blob", oid: async () => "x"},
          {type: async () => "blob", oid: async () => "x"},
        ])
        return [changed, same]
      }),
    } as unknown as GitProvider

    const res = await getPRPreviewData(git, "/r", "feature", "main")
    expect(res.success).toBe(true)
    expect(res.filesChanged).toContain("src/changed.ts")
    expect(treeMock).toHaveBeenCalled()
  })

  it("returns fork-specific error when sourceRemote is set but branch is missing", async () => {
    const git = {
      resolveRef: vi.fn(async () => {
        throw new Error("missing")
      }),
    } as unknown as GitProvider
    const res = await getPRPreviewData(git, "/r", "feature", "main", {sourceRemote: "fork"})
    expect(res.success).toBe(false)
    expect(res.error).toContain("not found on fork remote")
  })

  it("returns empty filesChanged when walk throws", async () => {
    const source = oid("1")
    const target = oid("2")
    const base = oid("3")
    const treeMock = vi.fn(() => ({}))
    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("feature")) return source
        if (ref.includes("main")) return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => base),
      log: vi.fn(async () => [{oid: source, commit: {message: "m"}}]),
      TREE: treeMock,
      walk: vi.fn(async () => {
        throw new Error("walk boom")
      }),
    } as unknown as GitProvider
    const res = await getPRPreviewData(git, "/r", "feature", "main")
    expect(res.success).toBe(true)
    expect(res.filesChanged).toEqual([])
  })
})

describe("merge-analysis: getCommitsAheadOfTipData", () => {
  it("returns error when listBranches fails", async () => {
    const git = {
      listBranches: vi.fn(async () => {
        throw new Error("no remote")
      }),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", oid("a"))
    expect(res.success).toBe(false)
    expect(res.error).toContain("Failed to list branches")
  })

  it("returns error when no branch contains the tip", async () => {
    const tip = oid("t")
    const git = {
      listBranches: vi.fn(async () => ["main"]),
      resolveRef: vi.fn(async () => oid("b")),
      isDescendent: vi.fn(async () => false),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip)
    expect(res.success).toBe(false)
    expect(res.error).toContain("No remote branch found")
  })

  it("returns error when branch contains tip but has no commits ahead", async () => {
    const tip = oid("t")
    const branchHead = oid("h")
    const git = {
      listBranches: vi.fn(async () => ["main"]),
      resolveRef: vi.fn(async () => branchHead),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => [{oid: tip, commit: {message: "tip"}}]),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip)
    expect(res.success).toBe(false)
    expect(res.error).toContain("No new commits")
  })

  it("returns commits when a remote branch is ahead of the tip", async () => {
    const tip = oid("t")
    const mid = oid("m")
    const head = oid("h")
    const git = {
      listBranches: vi.fn(async () => ["main"]),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("origin/main")) return head
        return head
      }),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => [
        {oid: head, commit: {message: "h"}},
        {oid: mid, commit: {message: "m"}},
        {oid: tip, commit: {message: "t"}},
      ]),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip, {sourceRemote: undefined})
    expect(res.success).toBe(true)
    expect(res.commitOids.length).toBeGreaterThan(0)
  })

  it("resolves refs/remotes/{sourceRemote}/{branch} when sourceRemote is set", async () => {
    const tip = oid("t")
    const head = oid("h")
    const git = {
      listBranches: vi.fn(async ({remote}: {remote?: string}) => {
        expect(remote).toBe("fork")
        return ["feature"]
      }),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        expect(ref).toBe("refs/remotes/fork/feature")
        return head
      }),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => [
        {oid: head, commit: {message: "h"}},
        {oid: tip, commit: {message: "t"}},
      ]),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip, {sourceRemote: "fork"})
    expect(res.success).toBe(true)
  })

  it("skips branches when resolveRef fails", async () => {
    const tip = oid("t")
    const head = oid("h")
    const git = {
      listBranches: vi.fn(async () => ["bad", "good"]),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("bad")) throw new Error("missing ref")
        return head
      }),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => [
        {oid: head, commit: {message: "h"}},
        {oid: tip, commit: {message: "t"}},
      ]),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip)
    expect(res.success).toBe(true)
  })

  it("skips branches when isDescendent throws", async () => {
    const tip = oid("t")
    const head = oid("h")
    const git = {
      listBranches: vi.fn(async () => ["main"]),
      resolveRef: vi.fn(async () => head),
      isDescendent: vi.fn(async () => {
        throw new Error("walk failed")
      }),
    } as unknown as GitProvider
    const res = await getCommitsAheadOfTipData(git, "/r", tip)
    expect(res.success).toBe(false)
    expect(res.error).toContain("No remote branch found")
  })
})

describe("merge-analysis: analyzePatchMergeability", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function patchFixture(raw: string, commits: {oid: string}[]) {
    return {
      id: "p1",
      commits: commits.map(c => ({
        oid: c.oid,
        message: "m",
        author: {name: "n", email: "e@e"},
      })),
      baseBranch: "main",
      raw: {content: raw},
    }
  }

  it("returns error for empty or missing patch content", async () => {
    const target = oid("t")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      fetch: vi.fn(async () => {}),
      log: vi.fn(async () => []),
    } as unknown as GitProvider

    const empty = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("", [{oid: oid("c")}]) as any,
      "main",
    )
    expect(empty.analysis).toBe("error")
    expect(empty.errorMessage).toContain("invalid patch")

    const notString = await analyzePatchMergeability(
      git,
      "/r",
      {
        ...patchFixture(" ", [{oid: oid("c")}]),
        raw: {content: null as unknown as string},
      } as any,
      "main",
    )
    expect(notString.analysis).toBe("error")
    expect(notString.errorMessage).toContain("invalid patch")
  })

  it("returns error when patch has no commits", async () => {
    const target = oid("t")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(git, "/r", patchFixture("diff\n", []) as any, "main")
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toContain("No commits")
  })

  it("returns up-to-date when patch commits appear in target log", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => [{remote: "origin", url: "https://ex/repo.git"}]),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("remotes/origin")) return target
        return target
      }),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => [{oid: c1, commit: {message: "x", author: {email: "e", name: "n"}}}]),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(" ", [{oid: c1}]) as any,
      "main",
    )
    expect(res.analysis).toBe("up-to-date")
    expect(res.upToDate).toBe(true)
  })

  it("returns fast-forward when target is ancestor of patch tip", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => oid("m")),
      isDescendent: vi.fn(async () => true),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/x b/x\n", [{oid: c1}]) as any,
      "main",
    )
    expect(res.analysis).toBe("clean")
    expect(res.fastForward).toBe(true)
    expect(res.canMerge).toBe(true)
  })

  it("returns diverged when local and remote heads differ and not ancestor", async () => {
    const local = oid("l")
    const remote = oid("r")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => [{remote: "origin", url: "https://ex/repo.git"}]),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("remotes/origin")) return remote
        return local
      }),
      isDescendent: vi.fn(async () => false),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => oid("m")),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/x b/x\n", [{oid: c1}]) as any,
      "main",
    )
    expect(res.analysis).toBe("diverged")
    expect(res.canMerge).toBe(false)
  })

  it("uses first listBranches entry when standard branch refs are missing", async () => {
    const c1 = oid("1")
    const branchOid = oid("z")
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === "refs/heads/unusual") return branchOid
      if (ref.startsWith("refs/heads/")) throw new Error("no branch")
      throw new Error(`unexpected ref ${ref}`)
    })
    const git = {
      listRemotes: vi.fn(async () => []),
      listBranches: vi.fn(async () => ["unusual"]),
      resolveRef,
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => branchOid),
      isDescendent: vi.fn(async () => false),
      readBlob: vi.fn(async () => ({blob: "same"})),
    } as unknown as GitProvider

    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(
        `diff --git a/foo.txt b/foo.txt
index 111..222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1 +1 @@
-a
+b
`,
        [{oid: c1}],
      ) as any,
      "main",
    )
    expect(resolveRef).toHaveBeenCalledWith({dir: "/r", ref: "refs/heads/unusual"})
    expect(res.analysis).toBe("clean")
    expect(res.canMerge).toBe(true)
  })

  it("maps catch block to analysis error", async () => {
    const git = {
      listRemotes: vi.fn(async () => {
        throw new Error("fs broken")
      }),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(" ", [{oid: oid("c")}]) as any,
      "main",
    )
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toBeDefined()
  })

  it("warns when fetch fails but continues analysis", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => [{remote: "origin", url: "https://ex/repo.git"}]),
      fetch: vi.fn(async () => {
        throw new Error("network")
      }),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(async () => true),
      readBlob: vi.fn(async () => ({blob: "x"})),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/x b/x\n", [{oid: c1}]) as any,
      "main",
    )
    expect(warn.mock.calls.some((c: string[]) => String(c[0]).includes("Failed to fetch remote"))).toBe(
      true,
    )
    expect(res.fastForward).toBe(true)
    warn.mockRestore()
  })

  it("warns when remote tracking ref cannot be resolved after fetch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const target = oid("t")
    const remote = oid("r")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => [{remote: "origin", url: "https://ex/repo.git"}]),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("remotes/origin")) throw new Error("no remote branch")
        return ref.includes("heads") ? target : remote
      }),
      isDescendent: vi.fn(async () => true),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => target),
      readBlob: vi.fn(async () => ({blob: "x"})),
    } as unknown as GitProvider
    await analyzePatchMergeability(git, "/r", patchFixture("diff --git a/x b/x\n", [{oid: c1}]) as any, "main")
    expect(
      warn.mock.calls.some((c: string[]) =>
        String(c[0]).includes("Could not resolve remote ref"),
      ),
    ).toBe(true)
    warn.mockRestore()
  })

  it("treats divergence check errors as remote divergence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const local = oid("l")
    const remote = oid("r")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => [{remote: "origin", url: "https://ex/repo.git"}]),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) =>
        ref.includes("remotes/origin") ? remote : local,
      ),
      isDescendent: vi.fn(async () => {
        throw new Error("graph error")
      }),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => oid("m")),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/x b/x\n", [{oid: c1}]) as any,
      "main",
    )
    expect(res.analysis).toBe("diverged")
    expect(
      warn.mock.calls.some((c: string[]) => String(c[0]).includes("Could not check branch divergence")),
    ).toBe(true)
    warn.mockRestore()
  })

  it("returns error when target branch resolves to empty oid", async () => {
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => ""),
      log: vi.fn(async () => []),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(" ", [{oid: oid("c")}]) as any,
      "main",
    )
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toMatch(/Failed to resolve target commit|resolve target/i)
  })

  it("uses merge base when isDescendent throws during fast-forward probe", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(async () => {
        throw new Error("missing graph")
      }),
      readBlob: vi.fn(async () => ({blob: "same"})),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/f.txt b/f.txt\n", [{oid: c1}]) as any,
      "main",
    )
    expect(res.fastForward).toBe(true)
    expect(res.analysis).toBe("clean")
  })

  it("detects already-applied patch via matching author and message", async () => {
    const target = oid("t")
    const patchOid = oid("p")
    const otherOid = oid("o")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => [
        {
          oid: otherOid,
          commit: {
            message: "same subject\n",
            author: {name: "a", email: "match@x.dev"},
          },
        },
      ]),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => {
        expect(o).toBe(patchOid)
        return {
          oid: patchOid,
          commit: {
            message: "same subject\n",
            author: {name: "a", email: "match@x.dev"},
          },
        }
      }),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(" ", [{oid: patchOid}]) as any,
      "main",
    )
    expect(res.analysis).toBe("up-to-date")
  })

  it("continues merge analysis when branch log cannot be read for patch-applied check", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => {
        throw new Error("log failed")
      }),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(async () => true),
      readBlob: vi.fn(async () => ({blob: "same"})),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture("diff --git a/z b/z\n", [{oid: c1}]) as any,
      "main",
    )
    expect(res.analysis).toBe("clean")
    expect(res.fastForward).toBe(true)
  })

  it("decodes readBlob results as Uint8Array in conflict analysis", async () => {
    const target = oid("t")
    const c1 = oid("1")
    const enc = new TextEncoder()
    const git = {
      listRemotes: vi.fn(async () => []),
      resolveRef: vi.fn(async () => target),
      log: vi.fn(async () => []),
      findMergeBase: vi.fn(async () => oid("m")),
      isDescendent: vi.fn(async () => false),
      readBlob: vi.fn(async () => ({blob: enc.encode("line\n")})),
    } as unknown as GitProvider
    const res = await analyzePatchMergeability(
      git,
      "/r",
      patchFixture(
        `diff --git a/bin.dat b/bin.dat
Binary files differ
`,
        [{oid: c1}],
      ) as any,
      "main",
    )
    expect(["clean", "conflicts"]).toContain(res.analysis)
  })
})

describe("merge-analysis: analyzePRMergeability", () => {
  beforeEach(() => {
    withUrlFallbackMock.mockReset()
  })

  it("fails when no valid clone URLs remain after filtering", async () => {
    const git = {} as GitProvider
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["nostr://fake"],
      tipCommitOid: oid("a"),
      targetBranch: "main",
    })
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toContain("No valid clone URLs")
  })

  it("fails strictTargetFresh when no valid target clone URLs", async () => {
    const git = {} as GitProvider
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://a.git"],
      targetCloneUrls: [],
      tipCommitOid: oid("a"),
      targetBranch: "main",
      strictTargetFresh: true,
    })
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toContain("target clone URLs")
  })

  it("fails when refreshing target from remote fails", async () => {
    withUrlFallbackMock.mockResolvedValueOnce({
      success: false,
      attempts: [{url: "https://base.git", success: false, error: "offline"}],
    })
    const git = {} as GitProvider
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      targetCloneUrls: ["https://base.git"],
      tipCommitOid: oid("a"),
      targetBranch: "main",
    })
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toContain("Failed to refresh target branch")
  })

  it("fails when all PR clone URL attempts fail", async () => {
    withUrlFallbackMock.mockResolvedValueOnce({
      success: false,
      attempts: [{url: "https://pr.git", success: false, error: "timeout"}],
    })
    const git = {} as GitProvider
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: oid("a"),
      targetBranch: "main",
    })
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toMatch(/timeout|Failed to fetch PR/)
  })

  it("returns up-to-date when target already contains PR tip", async () => {
    const target = oid("b")
    const tip = oid("a")
    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/main" || ref === `refs/heads/${"main"}`) return target
        throw new Error(ref)
      }),
      isDescendent: vi.fn(async ({ancestor}: {ancestor: string}) => ancestor === tip),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
    } as unknown as GitProvider

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => {
      const result = await op("https://pr.git")
      return {success: true, result, attempts: []}
    })

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("up-to-date")
    expect(res.upToDate).toBe(true)
    expect(res.usedCloneUrl).toBe("https://pr.git")
  })

  it("returns fast-forward clean result when tip is descendant of target", async () => {
    const target = oid("b")
    const tip = oid("a")
    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async () => target),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(
        async ({oid: o, ancestor}: {oid: string; ancestor: string}) => {
          if (o === target && ancestor === tip) return false
          if (o === tip && ancestor === target) return true
          return false
        },
      ),
      log: vi.fn(async () => [{oid: oid("x"), commit: {message: "other"}}]),
    } as unknown as GitProvider

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => {
      const result = await op("https://pr.git")
      return {success: true, result, attempts: []}
    })

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("clean")
    expect(res.fastForward).toBe(true)
    expect(res.canMerge).toBe(true)
  })

  it("marks up-to-date when tip oid appears in target log but isDescendent is false", async () => {
    const target = oid("b")
    const tip = oid("a")
    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async () => target),
      isDescendent: vi.fn(async () => false),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main")
          return [{oid: tip, commit: {message: "m", author: {name: "n", email: "e"}}}]
        return []
      }),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
    } as unknown as GitProvider

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("up-to-date")
  })

  it("runs target refresh then fails when PR fetch fails", async () => {
    let wf = 0
    withUrlFallbackMock.mockImplementation(async (urls: string[], op: (u: string) => Promise<any>) => {
      wf++
      if (wf === 1) {
        await op(urls[0])
        return {success: true, result: {oid: oid("z")}, attempts: []}
      }
      return {
        success: false,
        attempts: [{url: urls[0], success: false, error: "pr-down"}],
      }
    })

    const git = {
      deleteRemote: vi.fn(async () => {}),
      addRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("refs/remotes/pr-target") || ref.includes("pr-target")) return oid("z")
        if (ref === "refs/heads/main") return oid("z")
        throw new Error(ref)
      }),
      writeRef: vi.fn(async () => {}),
    } as unknown as GitProvider

    const getAuthCallback = vi.fn(() => ({username: "u"}))
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      targetCloneUrls: ["https://base.git"],
      tipCommitOid: oid("a"),
      targetBranch: "main",
      corsProxy: null,
      getAuthCallback,
    })
    expect(wf).toBe(2)
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toMatch(/pr-down|Failed to fetch PR/)
    expect(getAuthCallback).toHaveBeenCalled()
  })

  it("errors when robust branch resolution differs from requested target branch", async () => {
    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      listBranches: vi.fn(async () => ["main"]),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/release") throw new Error("missing")
        if (ref === "refs/heads/main") return oid("m")
        throw new Error(ref)
      }),
    } as unknown as GitProvider

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: oid("a"),
      targetBranch: "release",
    })
    expect(res.analysis).toBe("error")
    expect(res.errorMessage).toContain("not found after sync")
  })

  it("returns clean non-fast-forward when merge dry-run succeeds", async () => {
    const target = oid("b")
    const tip = oid("a")
    const mergeBase = oid("c")

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {
        throw new Error("config unavailable")
      }),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/main") return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => undefined),
      isDescendent: vi.fn(async () => false),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main") return []
        if (ref === tip)
          return [
            {oid: tip, commit: {message: "t", author: {name: "n", email: "e"}}},
            {oid: mergeBase, commit: {message: "m"}},
          ]
        return []
      }),
      checkout: vi.fn(async () => {}),
      branch: vi.fn(async () => {}),
      writeRef: vi.fn(async () => {}),
      merge: vi.fn(async () => ({})),
      deleteBranch: vi.fn(async ({ref}: {ref: string}) => {
        if (String(ref).includes("pr-merge-temp")) throw new Error("cleanup branch")
      }),
      deleteRef: vi.fn(async () => {}),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
    } as unknown as GitProvider

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("clean")
    expect(res.fastForward).toBe(false)
    expect(res.canMerge).toBe(true)
    expect(git.merge).toHaveBeenCalled()
    expect(warn.mock.calls.some((c: string[]) => String(c[0]).includes("Cleanup failed"))).toBe(true)
    warn.mockRestore()
  })

  it("continues when isDescendent throws inside checkIfPRApplied", async () => {
    const target = oid("b")
    const tip = oid("a")
    const mergeBase = oid("c")

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/main") return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => mergeBase),
      isDescendent: vi.fn(
        async ({oid: o, ancestor: a}: {oid: string; ancestor: string}) => {
          if (o === target && a === tip) throw new Error("cannot check ancestry")
          return false
        },
      ),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main") return []
        if (ref === tip)
          return [
            {oid: tip, commit: {message: "t", author: {name: "n", email: "e"}}},
            {oid: mergeBase, commit: {message: "m"}},
          ]
        return []
      }),
      checkout: vi.fn(async () => {}),
      branch: vi.fn(async () => {}),
      writeRef: vi.fn(async () => {}),
      merge: vi.fn(async () => ({})),
      deleteBranch: vi.fn(async () => {}),
      deleteRef: vi.fn(async () => {}),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
    } as unknown as GitProvider

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("clean")
    expect(res.canMerge).toBe(true)
  })

  it("returns conflicts when merge reports filepaths and parses marker files", async () => {
    const target = oid("b")
    const tip = oid("a")
    const mergeBase = oid("c")
    const markerBody = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n"

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const manyFiles = Array.from({length: 8}, (_, i) => `src/f${i}.ts`)

    const git: any = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "refs/heads/main") return target
        throw new Error(ref)
      }),
      findMergeBase: vi.fn(async () => mergeBase),
      isDescendent: vi.fn(async () => false),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main") return []
        if (ref === tip)
          return [
            {oid: tip, commit: {message: "t", author: {name: "n", email: "e"}}},
            {oid: mergeBase, commit: {message: "m"}},
          ]
        return []
      }),
      checkout: vi.fn(async () => {}),
      branch: vi.fn(async () => {}),
      writeRef: vi.fn(async () => {}),
      merge: vi.fn(async () => {
        const err: any = new Error("conflict")
        err.data = {filepaths: manyFiles}
        throw err
      }),
      deleteBranch: vi.fn(async () => {}),
      deleteRef: vi.fn(async () => {}),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
      fs: {
        promises: {
          readFile: vi.fn(async () => markerBody),
        },
      },
    }

    const res = await analyzePRMergeability(git as GitProvider, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("conflicts")
    expect(res.hasConflicts).toBe(true)
    expect(res.conflictFiles.length).toBeGreaterThan(0)
  })

  it("uses merge base when isDescendent throws during PR fast-forward probe", async () => {
    const target = oid("b")
    const tip = oid("a")

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async () => target),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(async () => {
        throw new Error("no walk")
      }),
      log: vi.fn(async () => []),
      readCommit: vi.fn(async ({oid: o}: {oid: string}) => ({
        oid: o,
        commit: {message: "m", author: {name: "n", email: "e"}},
      })),
    } as unknown as GitProvider

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.fastForward).toBe(true)
    expect(res.analysis).toBe("clean")
  })

  it("skips readCommit metadata when oid cannot be read", async () => {
    const target = oid("b")
    const tip = oid("a")

    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => ({
      success: true,
      result: await op("https://pr.git"),
      attempts: [],
    }))

    const git = {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      resolveRef: vi.fn(async () => target),
      findMergeBase: vi.fn(async () => target),
      isDescendent: vi.fn(
        async ({oid: o, ancestor: a}: {oid: string; ancestor: string}) =>
          o === tip && a === target,
      ),
      log: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main") return []
        if (ref === tip)
          return [{oid: target, commit: {message: "at merge base", author: {name: "n", email: "e"}}}]
        return []
      }),
      readCommit: vi.fn(async () => {
        throw new Error("missing commit")
      }),
    } as unknown as GitProvider

    const res = await analyzePRMergeability(git, "/r", {
      cloneUrls: ["https://pr.git"],
      tipCommitOid: tip,
      targetBranch: "main",
    })
    expect(res.analysis).toBe("clean")
    expect(res.fastForward).toBe(true)
    expect(res.prCommits).toEqual([])
  })
})
