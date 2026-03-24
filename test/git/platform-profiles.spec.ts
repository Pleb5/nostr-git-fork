import {describe, it, expect, beforeEach, afterEach, vi} from "vitest"
import {getPublicKey} from "nostr-tools"
import {hexToBytes} from "nostr-tools/utils"
import {
  DEFAULT_PROFILE_IMAGE_URL,
  createProfileEventForPlatformUser,
  generatePlatformUserProfile,
  generateRandomKeyPair,
  getProfileMapKey,
} from "../../src/git/platform-profiles.js"

describe("platform-profiles", () => {
  beforeEach(() => {
    vi.useFakeTimers({now: new Date("2025-06-15T12:00:00.000Z")})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("getProfileMapKey joins platform and username", () => {
    expect(getProfileMapKey("github", "alice")).toBe("github:alice")
    expect(getProfileMapKey("gitlab", "bob")).toBe("gitlab:bob")
  })

  it("DEFAULT_PROFILE_IMAGE_URL is empty string", () => {
    expect(DEFAULT_PROFILE_IMAGE_URL).toBe("")
  })

  it("generateRandomKeyPair returns 64-char hex privkey and matching pubkey", () => {
    const {privkey, pubkey} = generateRandomKeyPair()
    expect(privkey).toMatch(/^[0-9a-f]{64}$/)
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(getPublicKey(hexToBytes(privkey))).toBe(pubkey)
  })

  it("createProfileEventForPlatformUser builds kind 0 with mirrored name and signs", () => {
    const {privkey, pubkey} = generateRandomKeyPair()
    const ev = createProfileEventForPlatformUser("github", "alice", privkey)

    expect(ev.kind).toBe(0)
    expect(ev.pubkey).toBe(pubkey)
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(ev.tags).toEqual([["imported", ""]])
    expect(ev.created_at).toBe(Math.floor(new Date("2025-06-15T12:00:00.000Z").getTime() / 1000))

    const content = JSON.parse(ev.content) as {name: string; picture: string}
    expect(content.name).toBe("alice (mirrored user from github)")
    expect(content.picture).toBe("")
  })

  it("createProfileEventForPlatformUser rejects invalid privkey", () => {
    expect(() => createProfileEventForPlatformUser("github", "u", "not-hex")).toThrow(
      /Invalid private key format/,
    )
    expect(() => createProfileEventForPlatformUser("github", "u", "ab")).toThrow(
      /Invalid private key format/,
    )
  })

  it("generatePlatformUserProfile returns keys, platform metadata, and valid profile event", () => {
    const p = generatePlatformUserProfile("gitlab", "dev")

    expect(p.platform).toBe("gitlab")
    expect(p.originalUsername).toBe("dev")
    expect(p.privkey).toMatch(/^[0-9a-f]{64}$/)
    expect(p.pubkey).toBe(getPublicKey(hexToBytes(p.privkey)))
    expect(p.profileEvent.pubkey).toBe(p.pubkey)
    expect(p.profileEvent.kind).toBe(0)

    const body = JSON.parse(p.profileEvent.content) as {name: string}
    expect(body.name).toBe("dev (mirrored user from gitlab)")
  })
})
