import {describe, it, expect, vi} from "vitest"
import {generateSecretKey, getPublicKey} from "nostr-tools"
import {bytesToHex, hexToBytes} from "nostr-tools/utils"
import type {Comment, Issue, PullRequest} from "../../src/api/api.js"
import type {RepoMetadata} from "../../src/git/vendor-providers.js"
import {GIT_STATUS_CLOSED, GIT_STATUS_OPEN} from "../../src/events/index.js"
import {
  convertCommentsToNostrEvents,
  convertIssueStatusToEvent,
  convertIssuesToNostrEvents,
  convertPullRequestsToNostrEvents,
  convertRepoToNostrEvent,
  convertRepoToStateEvent,
  signEvent,
  type UserProfileMap,
} from "../../src/git/platform-to-nostr.js"

function makeRepo(overrides: Partial<RepoMetadata> = {}): RepoMetadata {
  return {
    id: "1",
    name: "my-repo",
    fullName: "org/my-repo",
    description: "A repo",
    defaultBranch: "main",
    isPrivate: false,
    cloneUrl: "https://github.com/org/my-repo.git",
    htmlUrl: "https://github.com/org/my-repo",
    owner: {login: "org", type: "Organization"},
    ...overrides,
  }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    number: 1,
    title: "Bug",
    body: "Details",
    state: "open",
    author: {login: "alice"},
    assignees: [],
    labels: [{name: "bug", color: "ff0000"}],
    createdAt: "2020-01-02T00:00:00.000Z",
    updatedAt: "2020-01-02T00:00:00.000Z",
    url: "https://api/issue/1",
    htmlUrl: "https://github.com/org/r/issues/1",
    ...overrides,
  }
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 10,
    body: "LGTM",
    author: {login: "bob"},
    createdAt: "2020-01-03T00:00:00.000Z",
    updatedAt: "2020-01-03T00:00:00.000Z",
    url: "https://api/c/10",
    htmlUrl: "https://github.com/org/r/issues/1#issuecomment-10",
    ...overrides,
  }
}

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 99,
    number: 2,
    title: "Feature",
    body: "PR body",
    state: "open",
    author: {login: "carol"},
    head: {
      ref: "feat",
      sha: "abc123def456789012345678901234567890abcd",
      repo: {name: "r", owner: "org"},
    },
    base: {
      ref: "main",
      sha: "baseeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      repo: {name: "r", owner: "org"},
    },
    merged: false,
    createdAt: "2020-01-04T00:00:00.000Z",
    updatedAt: "2020-01-04T00:00:00.000Z",
    url: "",
    htmlUrl: "",
    diffUrl: "",
    patchUrl: "",
    ...overrides,
  }
}

function randomKp(): {privkey: string; pubkey: string} {
  const sk = generateSecretKey()
  return {privkey: bytesToHex(sk), pubkey: getPublicKey(sk)}
}

describe("platform-to-nostr: convertRepoToNostrEvent", () => {
  it("uses last segment of fullName as repoId and appends imported tag", () => {
    const repo = makeRepo()
    const ev = convertRepoToNostrEvent(repo, ["wss://r.example"], "ab".repeat(32), 1_700_000_000)

    expect(ev.created_at).toBe(1_700_000_000)
    expect(ev.tags.some(t => t[0] === "imported")).toBe(true)
    const dTag = ev.tags.find(t => t[0] === "d")
    expect(dTag?.[1]).toBe("my-repo")
  })

  it("falls back to name when fullName has no usable segment", () => {
    const repo = makeRepo({fullName: "", name: "solo"})
    const ev = convertRepoToNostrEvent(repo, [], "cd".repeat(32), 100)
    const dTag = ev.tags.find(t => t[0] === "d")
    expect(dTag?.[1]).toBe("solo")
  })
})

describe("platform-to-nostr: convertRepoToStateEvent", () => {
  it("sets HEAD from defaultBranch and imported tag", () => {
    const ev = convertRepoToStateEvent(makeRepo({defaultBranch: "develop"}), 1_800_000_000)
    expect(ev.created_at).toBe(1_800_000_000)
    expect(ev.tags.some(t => t[0] === "imported")).toBe(true)
    const headTag = ev.tags.find(t => t[0] === "HEAD")
    expect(headTag?.[1]).toBe("ref: refs/heads/develop")
  })
})

describe("platform-to-nostr: convertIssuesToNostrEvents", () => {
  it("maps issues with profiles and increments timestamps", () => {
    const kp = randomKp()
    const profiles: UserProfileMap = new Map([["github:alice", kp]])
    const issues = [
      makeIssue({number: 1, author: {login: "alice"}}),
      makeIssue({number: 2, author: {login: "alice"}, title: "Second", body: ""}),
    ]

    const out = convertIssuesToNostrEvents(issues, "30617:npub:repo", "github", profiles, 0, 1000)

    expect(out).toHaveLength(2)
    expect(out[0].privkey).toBe(kp.privkey)
    expect(out[0].event.created_at).toBe(1000)
    expect(out[1].event.created_at).toBe(1001)
    expect(out[0].event.tags.find(t => t[0] === "original_date")?.[1]).toBe("1577923200")
  })

  it("skips issues when author has no profile", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const profiles: UserProfileMap = new Map()
    const out = convertIssuesToNostrEvents(
      [makeIssue({author: {login: "ghost"}})],
      "addr",
      "github",
      profiles,
      0,
      500,
    )
    expect(out).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("platform-to-nostr: convertIssueStatusToEvent", () => {
  it("uses open kind and content for open state", () => {
    const ev = convertIssueStatusToEvent("issuehex", "open", "2020-01-01T00:00:00Z", "addr", 2000)
    expect(ev.kind).toBe(GIT_STATUS_OPEN)
    expect(ev.content).toBe("open")
    expect(ev.tags.find(t => t[0] === "original_date")?.[1]).toBe("1577836800")
  })

  it("uses closed kind for closed state", () => {
    const ev = convertIssueStatusToEvent("issuehex", "closed", "2020-01-01T00:00:00Z", "addr", 2000)
    expect(ev.kind).toBe(GIT_STATUS_CLOSED)
    expect(ev.content).toBe("closed")
  })

  it("uses startTimestamp in original_date when date is invalid", () => {
    const ev = convertIssueStatusToEvent("e", "open", "not-a-date", "addr", 4242)
    expect(ev.tags.find(t => t[0] === "original_date")?.[1]).toBe("4242")
  })
})

describe("platform-to-nostr: convertCommentsToNostrEvents", () => {
  it("sorts by createdAt and adds parent e-tag when map has inReplyToId", () => {
    const alice = randomKp()
    const bob = randomKp()
    const profiles: UserProfileMap = new Map([
      ["github:alice", alice],
      ["github:bob", bob],
    ])
    const map = new Map<number, string>([[20, "parentnostreventid"]])
    const comments = [
      makeComment({id: 30, author: {login: "alice"}, createdAt: "2020-01-05T00:00:00.000Z"}),
      makeComment({
        id: 40,
        author: {login: "bob"},
        createdAt: "2020-01-04T00:00:00.000Z",
        inReplyToId: 20,
      }),
    ]

    const out = convertCommentsToNostrEvents(comments, "rootid", "github", profiles, map, 0, 3000)

    expect(out.map(c => c.platformCommentId)).toEqual([40, 30])
    const reply = out.find(c => c.platformCommentId === 40)!
    const eTags = reply.event.tags.filter(t => t[0] === "e")
    expect(eTags.some(t => t[1] === "parentnostreventid")).toBe(true)
  })

  it("skips comments without profile", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = convertCommentsToNostrEvents(
      [makeComment({author: {login: "nobody"}})],
      "root",
      "github",
      new Map(),
      new Map(),
      0,
      1,
    )
    expect(out).toHaveLength(0)
    warn.mockRestore()
  })
})

describe("platform-to-nostr: convertPullRequestsToNostrEvents", () => {
  it("uses last commit from prCommits when provided", () => {
    const kp = randomKp()
    const profiles: UserProfileMap = new Map([["github:carol", kp]])
    const pr = makePR()
    const prCommits = new Map([
      [2, ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"]],
    ])

    const out = convertPullRequestsToNostrEvents(
      [pr],
      "addr",
      "github",
      profiles,
      0,
      4000,
      prCommits,
    )

    expect(out).toHaveLength(1)
    const commitTag = out[0].event.tags.find(t => t[0] === "c")
    expect(commitTag?.[1]).toBe("2222222222222222222222222222222222222222")
  })

  it("falls back to head.sha without prCommits", () => {
    const kp = randomKp()
    const profiles: UserProfileMap = new Map([["github:carol", kp]])
    const pr = makePR()
    const out = convertPullRequestsToNostrEvents([pr], "addr", "github", profiles, 0, 5000)
    const commitTag = out[0].event.tags.find(t => t[0] === "c")
    expect(commitTag?.[1]).toBe(pr.head.sha)
  })

  it("skips PR when author missing from profiles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = convertPullRequestsToNostrEvents([makePR()], "addr", "github", new Map(), 0, 6000)
    expect(out).toHaveLength(0)
    warn.mockRestore()
  })
})

describe("platform-to-nostr: signEvent", () => {
  it("signs valid unsigned template", () => {
    const validPk = bytesToHex(generateSecretKey())
    const signed = signEvent({kind: 1, created_at: 1, tags: [], content: "hi"}, validPk)
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(signed.pubkey).toBe(getPublicKey(hexToBytes(validPk)))
  })

  it("throws on invalid private key", () => {
    expect(() => signEvent({kind: 1, created_at: 1, tags: [], content: ""}, "nope")).toThrow(
      /Invalid private key format/,
    )
  })
})
