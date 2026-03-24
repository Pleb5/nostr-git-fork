import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import type {GitProvider} from "../../src/git/provider.js"

const {withUrlFallbackMock} = vi.hoisted(() => ({
  withUrlFallbackMock: vi.fn(),
}))

const {analyzePRMergeabilityMock} = vi.hoisted(() => ({
  analyzePRMergeabilityMock: vi.fn(),
}))

vi.mock("../../src/utils/clone-url-fallback.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../../src/utils/clone-url-fallback.js")>()
  return {...orig, withUrlFallback: withUrlFallbackMock}
})

vi.mock("../../src/git/merge-analysis.js", () => ({
  analyzePRMergeability: analyzePRMergeabilityMock,
}))

import {
  analyzePRMergeUtil,
  inferProviderFromUrl,
  mergePRAndPushUtil,
} from "../../src/worker/workers/pr-merge.js"

const oid = (c: string) => c.repeat(40)

const defaultDeps = () => ({
  rootDir: "/repos",
  parseRepoId: (id: string) => id,
  resolveBranchName: vi.fn(async () => "main"),
  ensureFullClone: vi.fn(async () => {}),
  getAuthCallback: vi.fn(() => ({})),
  pushToRemote: vi.fn(async () => ({success: true})),
  safePushToRemote: vi.fn(async () => ({success: true})),
  getTokensForRemote: vi.fn(async () => [{token: "tok"}]),
})

describe("pr-merge: inferProviderFromUrl", () => {
  it("detects GRASP relay and grasp subdomains", () => {
    expect(inferProviderFromUrl("https://relay.ngit.dev/o/r.git")).toBe("grasp")
    expect(inferProviderFromUrl("https://foo.grasp.example/repo.git")).toBe("grasp")
  })

  it("detects GitHub hosts", () => {
    expect(inferProviderFromUrl("https://github.com/a/b.git")).toBe("github")
    expect(inferProviderFromUrl("https://api.github.com/foo")).toBe("github")
  })

  it("detects GitLab hosts", () => {
    expect(inferProviderFromUrl("https://gitlab.com/g/p.git")).toBe("gitlab")
    expect(inferProviderFromUrl("https://gitlab.example.org/x/y.git")).toBe("gitlab")
  })

  it("returns undefined for unknown or invalid URLs", () => {
    expect(inferProviderFromUrl("https://example.com/r.git")).toBeUndefined()
    expect(inferProviderFromUrl("not-a-url")).toBeUndefined()
  })
})

describe("pr-merge: analyzePRMergeUtil", () => {
  beforeEach(() => {
    analyzePRMergeabilityMock.mockReset()
  })

  it("forwards options to analyzePRMergeability with strictTargetFresh", async () => {
    const git = {} as GitProvider
    analyzePRMergeabilityMock.mockResolvedValue({
      canMerge: true,
      analysis: "clean",
      patchCommits: [oid("a")],
    } as any)

    const res = await analyzePRMergeUtil(
      git,
      {
        repoId: "owner/repo",
        prCloneUrls: ["https://pr.git"],
        targetCloneUrls: ["https://base.git"],
        tipCommitOid: oid("t"),
        targetBranch: "develop",
      },
      {
        rootDir: "/r",
        parseRepoId: id => id.replace("/", "_"),
        resolveBranchName: vi.fn(),
        getAuthCallback: () => ({user: "u"}),
        corsProxy: null,
      },
    )

    expect(analyzePRMergeabilityMock).toHaveBeenCalledWith(
      git,
      "/r/owner_repo",
      expect.objectContaining({
        cloneUrls: ["https://pr.git"],
        targetCloneUrls: ["https://base.git"],
        tipCommitOid: oid("t"),
        targetBranch: "develop",
        strictTargetFresh: true,
        getAuthCallback: expect.any(Function),
        corsProxy: null,
      }),
    )
    expect(res.canMerge).toBe(true)
  })

  it("defaults target branch to main when omitted", async () => {
    const git = {} as GitProvider
    analyzePRMergeabilityMock.mockResolvedValue({analysis: "clean"} as any)

    await analyzePRMergeUtil(
      git,
      {repoId: "r", prCloneUrls: ["https://p.git"], tipCommitOid: oid("1")},
      {rootDir: "/x", parseRepoId: (id: string) => id, resolveBranchName: vi.fn()},
    )

    expect(analyzePRMergeabilityMock).toHaveBeenCalledWith(
      git,
      "/x/r",
      expect.objectContaining({targetBranch: "main"}),
    )
  })
})

describe("pr-merge: mergePRAndPushUtil", () => {
  beforeEach(() => {
    withUrlFallbackMock.mockReset()
    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => {
      const result = await op("https://pr.git")
      return {success: true, result, attempts: []}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function baseGit(over: Partial<GitProvider> = {}): GitProvider {
    const tip = oid("p")
    const target = oid("m")
    const mergeOid = oid("x")
    return {
      addRemote: vi.fn(async () => {}),
      deleteRemote: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      writeRef: vi.fn(async () => {}),
      deleteRef: vi.fn(async () => {}),
      checkout: vi.fn(async () => {}),
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref.includes("pr-tip-merge") || ref.includes("refs/heads/main")) return tip
        return target
      }),
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => []),
      ...over,
    } as unknown as GitProvider
  }

  it("fails when no valid clone URLs remain after filtering", async () => {
    const git = baseGit()
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["nostr://x"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain("No valid clone URLs")
  })

  it("fails when fetch cannot retrieve the PR from any URL", async () => {
    withUrlFallbackMock.mockResolvedValue({
      success: false,
      attempts: [{url: "https://bad.git", success: false, error: "timeout"}],
    })
    const git = baseGit()
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://bad.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/timeout|Failed to fetch PR/)
  })

  it("uses generic fetch error when withUrlFallback fails without attempt details", async () => {
    withUrlFallbackMock.mockResolvedValue({success: false, attempts: []})
    const git = baseGit()
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe("Failed to fetch PR from any clone URL")
  })

  it("continues when setConfig or deleteRemote fail during PR fetch", async () => {
    const setConfig = vi.fn(async () => {
      throw new Error("no config")
    })
    const deleteRemote = vi.fn(async () => {
      throw new Error("already gone")
    })
    const git = baseGit({
      setConfig,
      deleteRemote,
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(true)
    expect(setConfig).toHaveBeenCalled()
    expect(deleteRemote).toHaveBeenCalled()
  })

  it("recreates temp PR ref when validation cannot read refs/heads target", async () => {
    const tip = oid("4")
    const preMerge = oid("m")
    let headsMainCalls = 0
    const writeRef = vi.fn(async () => {})
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === "main") return preMerge
      if (ref === "refs/heads/main") {
        headsMainCalls++
        if (headsMainCalls === 1) throw new Error("stale index")
        return preMerge
      }
      if (ref.startsWith("refs/pr-tip-merge")) return tip
      return tip
    })

    const git = baseGit({resolveRef, writeRef})

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: tip},
      defaultDeps() as any,
    )

    expect(res.success).toBe(true)
    expect(writeRef).toHaveBeenCalledWith(
      expect.objectContaining({value: tip, force: true}),
    )
  })

  it("writes a temp ref when fetch returns no prTipRef", async () => {
    const tip = oid("1")
    const mergeOid = oid("2")
    const writeRef = vi.fn(async () => {})
    const deleteRef = vi.fn(async () => {})
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref.startsWith("refs/pr-tip-merge")) return tip
      if (ref === "refs/heads/main" || ref === "main") return oid("m")
      return tip
    })
    const git = baseGit({
      writeRef,
      deleteRef,
      resolveRef,
      merge: vi.fn(async () => ({oid: mergeOid})),
    })

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: tip},
      defaultDeps() as any,
    )

    expect(res.success).toBe(true)
    expect(writeRef).toHaveBeenCalledWith(
      expect.objectContaining({value: tip, force: true}),
    )
    expect(deleteRef).toHaveBeenCalled()
  })

  it("returns merge OID and skips push when skipPush is true", async () => {
    const mergeOid = oid("m")
    const listRemotes = vi.fn(async () => [{remote: "origin", url: "https://github.com/a/b.git"}])
    const git = baseGit({
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes,
    })

    const res = await mergePRAndPushUtil(
      git,
      {
        repoId: "a/b",
        cloneUrls: ["https://pr.git"],
        tipCommitOid: oid("t"),
        skipPush: true,
      },
      defaultDeps() as any,
    )

    expect(res.success).toBe(true)
    expect(res.mergeCommitOid).toBe(mergeOid)
    expect(res.warning).toMatch(/deferred|Push deferred/i)
    expect(listRemotes).not.toHaveBeenCalled()
  })

  it("warns when there are no remotes after merge", async () => {
    const git = baseGit({listRemotes: vi.fn(async () => [])})
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(true)
    expect(res.warning).toMatch(/No remotes configured/)
  })

  it("records push errors for remotes without URL and still succeeds if another remote pushes", async () => {
    const mergeOid = oid("z")
    const git = baseGit({
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => [
        {remote: "broken", url: ""},
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })
    const deps = defaultDeps()

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      deps as any,
    )

    expect(res.success).toBe(true)
    expect(res.pushErrors?.some(e => e.code === "NO_URL")).toBe(true)
    expect(res.pushedRemotes).toContain("origin")
  })

  it("uses pushToRemote for GRASP with userPubkey and authHeaders", async () => {
    const mergeOid = oid("z")
    const pushToRemote = vi.fn(async () => ({success: true}))
    const git = baseGit({
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://relay.ngit.dev/npub1abc/repo.git"},
      ]),
    })

    await mergePRAndPushUtil(
      git,
      {
        repoId: "a/b",
        cloneUrls: ["https://pr.git"],
        tipCommitOid: oid("t"),
        userPubkey: "npub1test",
        authHeaders: {"https://relay.ngit.dev/": "Authorization: Nostr xxx"},
      },
      {...defaultDeps(), pushToRemote} as any,
    )

    expect(pushToRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "grasp",
        token: "npub1test",
        authHeaders: expect.objectContaining({
          "https://relay.ngit.dev/": expect.any(String),
        }),
      }),
    )
  })

  it("fails GRASP push when userPubkey is missing", async () => {
    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://relay.ngit.dev/o/r.git"},
      ]),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/userPubkey|GRASP push requires/)
  })

  it("uses safePushToRemote with tokens for GitHub", async () => {
    const safePushToRemote = vi.fn(async () => ({success: true}))
    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })

    await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {...defaultDeps(), safePushToRemote} as any,
    )

    expect(safePushToRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        preflight: expect.objectContaining({requireUpToDate: true}),
      }),
    )
  })

  it("fails when no auth tokens exist for non-GRASP remote", async () => {
    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {...defaultDeps(), getTokensForRemote: vi.fn(async () => [])} as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No authentication token|Push to/)
  })

  it("returns structured conflict message when merge error includes filepaths", async () => {
    const git = baseGit({
      merge: vi.fn(async () => {
        const err: any = new Error("conflict")
        err.data = {filepaths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]}
        throw err
      }),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain("Merge conflicts")
    expect(res.error).toContain("more")
  })

  it("returns generic merge error when there are no conflict filepaths", async () => {
    const git = baseGit({
      merge: vi.fn(async () => {
        throw new Error("refusing to merge unrelated histories")
      }),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain("Merge failed")
  })

  it("fails when merge returns no commit OID", async () => {
    const git = baseGit({merge: vi.fn(async () => ({}))})
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      defaultDeps() as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain("no commit OID")
  })

  it("resets target branch when every push fails", async () => {
    const preMerge = oid("0")
    const mergeOid = oid("9")
    const writeRef = vi.fn(async () => {})
    const checkout = vi.fn(async () => {})
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === "refs/heads/main" || ref === "main") return preMerge
      return oid("p")
    })

    const git = baseGit({
      resolveRef,
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
      writeRef,
      checkout,
    })

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        safePushToRemote: vi.fn(async () => ({success: false, error: "rejected"})),
      } as any,
    )

    expect(res.success).toBe(false)
    expect(writeRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "refs/heads/main",
        value: preMerge,
        force: true,
      }),
    )
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({ref: "main", force: true}),
    )
  })

  it("uses fetched prTipRef without writing a temp ref", async () => {
    const fetchedRef = "refs/remotes/pr-source-xyz/feature"
    const tip = oid("7")
    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => {
      const result = await op("https://pr.git")
      return {
        success: true,
        result: {prTipRef: fetchedRef, tipOid: tip},
        attempts: [],
      }
    })

    const writeRef = vi.fn(async () => {})
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === fetchedRef) return tip
      if (ref === "refs/heads/main" || ref === "main") return oid("m")
      return tip
    })

    const git = baseGit({writeRef, resolveRef})

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: tip},
      defaultDeps() as any,
    )

    expect(res.success).toBe(true)
    expect(writeRef).not.toHaveBeenCalledWith(
      expect.objectContaining({ref: expect.stringContaining("pr-tip-merge")}),
    )
  })

  it("returns validation error when fetched ref disappears and temp ref was not used", async () => {
    const fetchedRef = "refs/remotes/pr-source/stable"
    withUrlFallbackMock.mockImplementation(async (_urls: string[], op: (u: string) => Promise<any>) => {
      const result = await op("https://pr.git")
      return {
        success: true,
        result: {prTipRef: fetchedRef, tipOid: oid("9")},
        attempts: [],
      }
    })

    let refCalls = 0
    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === fetchedRef) {
        refCalls++
        if (refCalls === 1) return oid("9")
        throw new Error("ref gone")
      }
      if (ref === "refs/heads/main" || ref === "main") return oid("m")
      return oid("9")
    })

    const git = baseGit({resolveRef})

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("9")},
      defaultDeps() as any,
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Reference validation failed|ref gone/)
  })

  it("propagates top-level dependency failures", async () => {
    const git = baseGit()
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        resolveBranchName: vi.fn(async () => {
          throw new Error("branch resolver down")
        }),
      } as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain("branch resolver down")
  })

  it("fails when GRASP pushToRemote reports failure", async () => {
    const mergeOid = oid("z")
    const git = baseGit({
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://relay.ngit.dev/npub1abc/r.git"},
      ]),
    })
    const res = await mergePRAndPushUtil(
      git,
      {
        repoId: "a/b",
        cloneUrls: ["https://pr.git"],
        tipCommitOid: oid("t"),
        userPubkey: "npub1x",
      },
      {
        ...defaultDeps(),
        pushToRemote: vi.fn(async () => ({success: false, error: "relay rejected"})),
      } as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/relay rejected|Push to origin failed/)
  })

  it("fails when safe push requires confirmation", async () => {
    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        safePushToRemote: vi.fn(async () => ({
          success: false,
          requiresConfirmation: true,
          warning: "Non-fast-forward; confirm force push",
        })),
      } as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/confirm|Force push|Non-fast-forward/)
  })

  it("fails when GitHub reports missing workflow scope", async () => {
    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })
    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        safePushToRemote: vi.fn(async () => ({
          success: false,
          reason: "workflow_scope_missing",
          error: "scope",
        })),
      } as any,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/workflow token scope|\.github\/workflows/)
  })

  it("retries safe push with the next token when the first fails", async () => {
    const safePushToRemote = vi.fn()
    safePushToRemote
      .mockResolvedValueOnce({success: false, error: "first token bad"})
      .mockResolvedValueOnce({success: true})

    const git = baseGit({
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
    })

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        safePushToRemote,
        getTokensForRemote: vi.fn(async () => [{token: "a"}, {token: "b"}]),
      } as any,
    )

    expect(res.success).toBe(true)
    expect(safePushToRemote).toHaveBeenCalledTimes(2)
  })

  it("warns when resetting local branch after failed pushes throws", async () => {
    const preMerge = oid("0")
    const mergeOid = oid("9")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref === "refs/heads/main" || ref === "main") return preMerge
      return oid("p")
    })

    const writeRef = vi.fn(async (opts: {ref?: string; value?: string; force?: boolean}) => {
      if (opts.ref === "refs/heads/main" && opts.value === preMerge && opts.force) {
        throw new Error("cannot reset ref")
      }
    })

    const git = baseGit({
      resolveRef,
      merge: vi.fn(async () => ({oid: mergeOid})),
      listRemotes: vi.fn(async () => [
        {remote: "origin", url: "https://github.com/a/b.git"},
      ]),
      writeRef,
      checkout: vi.fn(async () => {}),
    })

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: oid("t")},
      {
        ...defaultDeps(),
        safePushToRemote: vi.fn(async () => ({success: false, error: "rejected"})),
      } as any,
    )

    expect(res.success).toBe(false)
    expect(warn.mock.calls.some((c: string[]) => String(c[0]).includes("Failed to reset local"))).toBe(
      true,
    )
    warn.mockRestore()
  })

  it("ignores deleteRef errors when cleaning up temp PR ref", async () => {
    const tip = oid("1")
    const deleteRef = vi.fn(async () => {
      throw new Error("ref locked")
    })

    const resolveRef = vi.fn(async ({ref}: {ref: string}) => {
      if (ref.startsWith("refs/pr-tip-merge")) return tip
      if (ref === "refs/heads/main" || ref === "main") return oid("m")
      return tip
    })

    const git = baseGit({deleteRef, resolveRef})

    const res = await mergePRAndPushUtil(
      git,
      {repoId: "a/b", cloneUrls: ["https://pr.git"], tipCommitOid: tip},
      defaultDeps() as any,
    )

    expect(res.success).toBe(true)
    expect(deleteRef).toHaveBeenCalled()
  })
})
