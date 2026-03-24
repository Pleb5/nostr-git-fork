import {beforeEach, describe, expect, it, vi} from "vitest"
import type {GitProvider} from "../../src/git/provider.js"

const {gitApiMock, getGitServiceApiMock} = vi.hoisted(() => {
  const gitApiMock = {
    createRepo: vi.fn(),
    updateRepo: vi.fn(),
    forkRepo: vi.fn(),
    getRepo: vi.fn(),
  }
  const getGitServiceApiMock = vi.fn(() => gitApiMock)
  return {gitApiMock, getGitServiceApiMock}
})

const {parseRepoFromUrlMock} = vi.hoisted(() => ({
  parseRepoFromUrlMock: vi.fn(),
}))

const {resolveDefaultCorsProxyMock} = vi.hoisted(() => ({
  resolveDefaultCorsProxyMock: vi.fn((): string | null => "https://cors.isomorphic-git.org"),
}))

vi.mock("../../src/git/provider-factory.js", () => ({
  getGitServiceApi: getGitServiceApiMock,
}))

vi.mock("../../src/git/vendor-provider-factory.js", () => ({
  parseRepoFromUrl: (...args: unknown[]) => parseRepoFromUrlMock(...(args as [string])),
}))

vi.mock("../../src/worker/workers/git-config.js", () => ({
  resolveDefaultCorsProxy: resolveDefaultCorsProxyMock,
}))

const {cloneRemoteRepoUtilMock} = vi.hoisted(() => ({
  cloneRemoteRepoUtilMock: vi.fn(async (..._args: unknown[]) => {}),
}))

vi.mock("../../src/worker/workers/repos.js", () => ({
  cloneRemoteRepoUtil: (...args: unknown[]) => cloneRemoteRepoUtilMock(...args),
}))

import {
  createLocalRepo,
  createRemoteRepo,
  deleteRemoteRepo,
  forkAndCloneRepo,
  getGitignoreTemplate,
  getLicenseTemplate,
  updateAndPushFiles,
  updateRemoteRepoMetadata,
} from "../../src/worker/workers/repo-management.js"

describe("repo-management: templates", () => {
  it("getGitignoreTemplate returns content for known keys", async () => {
    const node = await getGitignoreTemplate("node")
    expect(node).toContain("node_modules")
    const svelte = await getGitignoreTemplate("svelte")
    expect(svelte).toContain(".svelte-kit")
  })

  it("getGitignoreTemplate returns empty string for unknown template", async () => {
    expect(await getGitignoreTemplate("unknown-stack")).toBe("")
  })

  it("getLicenseTemplate interpolates author and year for MIT", async () => {
    const text = await getLicenseTemplate("mit", "Jane Doe")
    expect(text).toContain("Jane Doe")
    expect(text).toContain(String(new Date().getFullYear()))
    expect(text).toContain("MIT License")
  })

  it("getLicenseTemplate supports apache-2.0, gpl-3.0, and unlicense", async () => {
    expect(await getLicenseTemplate("apache-2.0", "Org")).toContain("Apache License")
    expect(await getLicenseTemplate("gpl-3.0", "Org")).toContain("GENERAL PUBLIC LICENSE")
    expect(await getLicenseTemplate("unlicense", "x")).toContain("public domain")
  })

  it("getLicenseTemplate returns empty for unknown license id", async () => {
    expect(await getLicenseTemplate("proprietary", "A")).toBe("")
  })
})

describe("repo-management: createRemoteRepo", () => {
  beforeEach(() => {
    gitApiMock.createRepo.mockReset()
    getGitServiceApiMock.mockClear()
  })

  it("creates repo and returns clone URL", async () => {
    gitApiMock.createRepo.mockResolvedValue({
      cloneUrl: "https://github.com/u/r.git",
    })

    const res = await createRemoteRepo({
      provider: "github",
      token: "tok",
      name: "r",
      description: "d",
      isPrivate: true,
    })

    expect(res.success).toBe(true)
    expect(res.remoteUrl).toBe("https://github.com/u/r.git")
    expect(gitApiMock.createRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "r",
        description: "d",
        private: true,
        autoInit: false,
      }),
    )
    expect(getGitServiceApiMock).toHaveBeenCalledWith("github", "tok", undefined)
  })

  it("rewrites GRASP ws(s) clone URLs to http(s)", async () => {
    gitApiMock.createRepo.mockResolvedValue({
      cloneUrl: "wss://relay.example/r.git",
    })

    const res = await createRemoteRepo({
      provider: "grasp",
      token: "t",
      name: "r",
      baseUrl: "https://api",
    })

    expect(res.success).toBe(true)
    expect(res.remoteUrl).toBe("https://relay.example/r.git")
    expect(getGitServiceApiMock).toHaveBeenCalledWith("grasp", "t", "https://api")
  })

  it("fails when token is missing or blank", async () => {
    const a = await createRemoteRepo({provider: "github", token: "", name: "r"})
    expect(a.success).toBe(false)
    expect(a.error).toMatch(/token/i)

    const b = await createRemoteRepo({provider: "github", token: "   ", name: "r"})
    expect(b.success).toBe(false)
  })

  it("maps API errors to result.error", async () => {
    gitApiMock.createRepo.mockRejectedValue(new Error("rate limited"))
    const res = await createRemoteRepo({provider: "github", token: "t", name: "r"})
    expect(res.success).toBe(false)
    expect(res.error).toBe("rate limited")
  })
})

describe("repo-management: updateRemoteRepoMetadata", () => {
  beforeEach(() => {
    gitApiMock.updateRepo.mockReset()
  })

  it("updates repo via GitServiceApi", async () => {
    gitApiMock.updateRepo.mockResolvedValue({id: 1})
    const res = await updateRemoteRepoMetadata({
      owner: "a",
      repo: "b",
      updates: {name: "n", description: "d", private: false},
      token: "t",
      provider: "gitlab",
    })
    expect(res.success).toBe(true)
    expect(res.updatedRepo).toEqual({id: 1})
    expect(gitApiMock.updateRepo).toHaveBeenCalledWith("a", "b", {
      name: "n",
      description: "d",
      private: false,
    })
    expect(getGitServiceApiMock).toHaveBeenCalledWith("gitlab", "t")
  })

  it("defaults provider to github", async () => {
    gitApiMock.updateRepo.mockResolvedValue({})
    await updateRemoteRepoMetadata({
      owner: "a",
      repo: "b",
      updates: {},
      token: "t",
    })
    expect(getGitServiceApiMock).toHaveBeenCalledWith("github", "t")
  })

  it("returns failure when updateRepo throws", async () => {
    gitApiMock.updateRepo.mockRejectedValue(new Error("forbidden"))
    const res = await updateRemoteRepoMetadata({
      owner: "a",
      repo: "b",
      updates: {},
      token: "t",
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe("forbidden")
  })
})

describe("repo-management: deleteRemoteRepo", () => {
  beforeEach(() => {
    parseRepoFromUrlMock.mockReset()
  })

  it("parses URL and calls provider.deleteRepo", async () => {
    const deleteRepo = vi.fn().mockResolvedValue(undefined)
    parseRepoFromUrlMock.mockReturnValue({
      provider: {deleteRepo},
      owner: "o",
      repo: "r",
    })

    const res = await deleteRemoteRepo({
      remoteUrl: "https://github.com/o/r.git",
      token: "t",
    })

    expect(res.success).toBe(true)
    expect(deleteRepo).toHaveBeenCalledWith("o", "r", "t")
  })

  it("fails when URL cannot be parsed", async () => {
    parseRepoFromUrlMock.mockReturnValue(null)
    const res = await deleteRemoteRepo({remoteUrl: "bad", token: "t"})
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/parse|Unable to parse/)
  })

  it("maps deleteRepo failures", async () => {
    parseRepoFromUrlMock.mockReturnValue({
      provider: {
        deleteRepo: vi.fn().mockRejectedValue(new Error("404")),
      },
      owner: "a",
      repo: "b",
    })
    const res = await deleteRemoteRepo({remoteUrl: "https://x/a/b.git", token: "t"})
    expect(res.success).toBe(false)
    expect(res.error).toBe("404")
  })
})

describe("repo-management: createLocalRepo", () => {
  function makeGitWithFs() {
    const written: string[] = []
    const fs = {
      promises: {
        writeFile: vi.fn(async (p: string) => {
          written.push(p)
        }),
        mkdir: vi.fn(async () => {}),
      },
    }
    const git = {
      fs,
      init: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "abc123"),
    } as unknown as GitProvider
    return {git, written}
  }

  it("initializes repo, writes README, optional gitignore and license, commits", async () => {
    const {git} = makeGitWithFs()
    const cloned = new Set<string>()
    const levels = new Map<string, string>()

    const res = await createLocalRepo(git, "/root", cloned, levels, {
      repoId: "owner/myrepo",
      name: "My Repo",
      description: "Hello",
      defaultBranch: "main",
      initializeWithReadme: true,
      gitignoreTemplate: "node",
      licenseTemplate: "mit",
      authorName: "A",
      authorEmail: "a@b.c",
    })

    expect(res.success).toBe(true)
    expect(res.commitSha).toBe("abc123")
    expect(res.files).toEqual(expect.arrayContaining(["README.md", ".gitignore", "LICENSE"]))
    expect(git.init).toHaveBeenCalledWith({dir: "/root/owner/myrepo", defaultBranch: "main"})
    expect(git.commit).toHaveBeenCalledWith(
      expect.objectContaining({message: "Initial commit", author: {name: "A", email: "a@b.c"}}),
    )
    expect(cloned.has("owner/myrepo")).toBe(true)
    expect(levels.get("owner/myrepo")).toBe("full")
  })

  it("can omit readme and templates", async () => {
    const {git} = makeGitWithFs()
    const res = await createLocalRepo(git, "/root", new Set(), new Map(), {
      repoId: "u/r",
      name: "R",
      authorName: "A",
      authorEmail: "e@e.e",
      initializeWithReadme: false,
      gitignoreTemplate: "none",
      licenseTemplate: "none",
    })
    expect(res.success).toBe(true)
    expect(res.files).toEqual([])
    expect(git.add).not.toHaveBeenCalled()
  })

  it("fails when provider has no filesystem", async () => {
    const git = {
      init: vi.fn(async () => {}),
    } as unknown as GitProvider
    const res = await createLocalRepo(git, "/root", new Set(), new Map(), {
      repoId: "u/r",
      name: "R",
      authorName: "A",
      authorEmail: "e@e.e",
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/File system provider|not available/)
  })
})

describe("repo-management: updateAndPushFiles", () => {
  beforeEach(() => {
    resolveDefaultCorsProxyMock.mockReturnValue("https://cors.isomorphic-git.org")
  })

  it("writes nested files, commits, and pushes with CORS proxy for non-grasp", async () => {
    const push = vi.fn(async (_opts: unknown) => {})
    const fs = {
      promises: {
        writeFile: vi.fn(async () => {}),
        mkdir: vi.fn(async () => {}),
      },
    }
    const git = {
      fs,
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "commit99"),
      push,
    } as unknown as GitProvider

    const stages: string[] = []
    const res = await updateAndPushFiles(git, {
      dir: "/repo",
      files: [{path: "src/deep/file.txt", content: "x"}],
      commitMessage: "chore: update",
      token: "ghp_xxx",
      provider: "github",
      onProgress: s => stages.push(s),
    })

    expect(res.success).toBe(true)
    expect(res.commitId).toBe("commit99")
    expect(fs.promises.mkdir).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/repo",
        force: false,
        corsProxy: "https://cors.isomorphic-git.org",
        onAuth: expect.any(Function),
      }),
    )
    const pushOpts = push.mock.calls[0]?.[0] as unknown as {
      onAuth: () => {username: string; password: string}
    }
    expect(pushOpts).toBeDefined()
    expect(pushOpts.onAuth()).toEqual({username: "token", password: "ghp_xxx"})
    expect(stages.length).toBeGreaterThan(0)
  })

  it("omits corsProxy when resolveDefaultCorsProxy returns null", async () => {
    resolveDefaultCorsProxyMock.mockReturnValueOnce(null)
    const push = vi.fn(async (_opts: unknown) => {})
    const git = {
      fs: {
        promises: {
          writeFile: vi.fn(async () => {}),
          mkdir: vi.fn(async () => {}),
        },
      },
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "c2"),
      push,
    } as unknown as GitProvider

    await updateAndPushFiles(git, {
      dir: "/r",
      files: [{path: "f", content: "1"}],
      commitMessage: "m",
      token: "t",
      provider: "github",
    })

    const pushArgs = push.mock.calls[0]?.[0]
    expect(pushArgs).toBeDefined()
    expect(pushArgs).not.toHaveProperty("corsProxy")
  })

  it("uses grasp auth shape and omits corsProxy in push options", async () => {
    const push = vi.fn(async (_opts: unknown) => {})
    const git = {
      fs: {
        promises: {
          writeFile: vi.fn(async () => {}),
          mkdir: vi.fn(async () => {}),
        },
      },
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "c1"),
      push,
    } as unknown as GitProvider

    await updateAndPushFiles(git, {
      dir: "/r",
      files: [{path: "f", content: "1"}],
      commitMessage: "m",
      token: "npub1abc",
      provider: "grasp",
    })

    const graspPushOpts = push.mock.calls[0]?.[0] as unknown as {
      corsProxy?: string
      onAuth: () => {username: string; password: string}
    }
    expect(graspPushOpts).toBeDefined()
    expect(graspPushOpts.corsProxy).toBeUndefined()
    expect(graspPushOpts.onAuth()).toEqual({username: "npub1abc", password: "grasp"})
  })

  it("fails when filesystem is missing", async () => {
    const git = {add: vi.fn(), commit: vi.fn(), push: vi.fn()} as unknown as GitProvider
    const res = await updateAndPushFiles(git, {
      dir: "/r",
      files: [{path: "a", content: "b"}],
      commitMessage: "m",
      token: "t",
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Filesystem not available/)
  })

  it("maps commit or push errors", async () => {
    const git = {
      fs: {promises: {writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {})}},
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => {
        throw new Error("nothing to commit")
      }),
      push: vi.fn(async () => {}),
    } as unknown as GitProvider

    const res = await updateAndPushFiles(git, {
      dir: "/r",
      files: [{path: "x", content: "y"}],
      commitMessage: "m",
      token: "t",
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain("nothing to commit")
  })
})

describe("repo-management: forkAndCloneRepo", () => {
  beforeEach(() => {
    getGitServiceApiMock.mockClear()
    gitApiMock.forkRepo.mockReset()
    gitApiMock.getRepo.mockReset()
    cloneRemoteRepoUtilMock.mockReset()
  })

  it("returns error result when fork parameters are invalid", async () => {
    const git = {} as GitProvider
    const res = await forkAndCloneRepo(git, {}, "/root", {
      owner: "  ",
      repo: "src",
      forkName: "fork",
      visibility: "public",
      token: "t",
      dir: "dest",
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Invalid parameters for fork/)
    expect(getGitServiceApiMock).not.toHaveBeenCalled()
  })

  it("completes same-platform fork: forkRepo, poll getRepo, clone fork", async () => {
    gitApiMock.forkRepo.mockResolvedValue({
      name: "my-fork",
      owner: {login: "forker"},
      cloneUrl: "https://github.com/forker/my-fork.git",
    })
    gitApiMock.getRepo.mockResolvedValue({id: 1, name: "my-fork"})

    const git = {
      resolveRef: vi.fn(async ({ref}: {ref: string}) => {
        if (ref === "main") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        throw new Error("missing ref")
      }),
      listBranches: vi.fn(async () => ["main"]),
      listTags: vi.fn(async () => ["v0"]),
      fs: {promises: {rmdir: vi.fn(async () => {})}},
    } as unknown as GitProvider

    const res = await forkAndCloneRepo(git, {}, "/repos", {
      owner: "upstream",
      repo: "lib",
      forkName: "my-fork",
      visibility: "public",
      token: "ghp_test",
      dir: "fork-workdir",
      provider: "github",
    })

    expect(res.success).toBe(true)
    expect(res.repoId).toBe("forker/my-fork")
    expect(res.forkUrl).toBe("https://github.com/forker/my-fork.git")
    expect(res.defaultBranch).toBe("main")
    expect(res.branches).toEqual(["main"])
    expect(res.tags).toEqual(["v0"])
    expect(gitApiMock.forkRepo).toHaveBeenCalledWith("upstream", "lib", {name: "my-fork"})
    expect(gitApiMock.getRepo).toHaveBeenCalledWith("forker", "my-fork")
    expect(cloneRemoteRepoUtilMock).toHaveBeenCalledWith(
      git,
      {},
      expect.objectContaining({
        url: "https://github.com/forker/my-fork.git",
        dir: "/repos/fork-workdir",
        depth: 50,
        token: "ghp_test",
      }),
    )
  })

  it("rewrites wss fork URL to https when cloning grasp fork", async () => {
    gitApiMock.forkRepo.mockResolvedValue({
      name: "f",
      owner: {login: "n"},
      cloneUrl: "wss://relay.example/f.git",
    })
    gitApiMock.getRepo.mockResolvedValue({id: 1})

    const git = {
      resolveRef: vi.fn(async () => "a".repeat(40)),
      listBranches: vi.fn(async () => ["main"]),
      listTags: vi.fn(async () => []),
      fs: {promises: {rmdir: vi.fn(async () => {})}},
    } as unknown as GitProvider

    await forkAndCloneRepo(git, {}, "/r", {
      owner: "a",
      repo: "b",
      forkName: "f",
      visibility: "public",
      token: "npub",
      dir: "d",
      provider: "grasp",
      baseUrl: "wss://relay.example",
    })

    expect(cloneRemoteRepoUtilMock).toHaveBeenCalledWith(
      git,
      {},
      expect.objectContaining({url: "https://relay.example/f.git"}),
    )
  })

  it("fails when API fork uses a different repo name than requested", async () => {
    gitApiMock.forkRepo.mockResolvedValue({
      name: "existing-other-name",
      owner: {login: "u"},
      cloneUrl: "https://github.com/u/existing-other-name.git",
    })

    const git = {fs: {promises: {rmdir: vi.fn(async () => {})}}} as unknown as GitProvider

    const res = await forkAndCloneRepo(git, {}, "/r", {
      owner: "a",
      repo: "b",
      forkName: "wanted",
      visibility: "public",
      token: "t",
      dir: "d",
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Fork already exists with name/)
    expect(cloneRemoteRepoUtilMock).not.toHaveBeenCalled()
  })
})
