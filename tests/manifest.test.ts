import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { ConnectReadScope } from "../src/core/capabilities.js"

// Structural checks on the shipped manifest.
//
// `openwork-app validate` is the authoritative gate and runs in CI. These tests
// cover the things only Station knows: that the manifest still matches what the
// code actually does, and that its privacy story stays honest as the app grows.

type Manifest = {
  id: string
  version: string
  entrypoints: { background?: string; surfaces: Record<string, string> }
  contributions: Array<Record<string, unknown> & { type: string; id: string }>
  permissions: Array<Record<string, unknown> & { id: string }>
  environment: { required: Array<{ key: string }>; optional: Array<{ key: string }> }
  privacy: { data_handled: string[]; third_parties: Array<{ host: string }> }
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "openwork.app.json"), "utf8"),
) as Manifest

function permission(id: string) {
  return manifest.permissions.find((entry) => entry.id === id)
}

describe("shipped manifest", () => {
  test("its version matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version: string }
    expect(manifest.version).toBe(pkg.version)
  })

  test("the app id is reverse-DNS, so it cannot shadow a built-in extension", () => {
    expect(manifest.id).toContain(".")
    expect(manifest.id).toBe(manifest.id.toLowerCase())
  })

  test("every Connect scope it requests is one the code models", () => {
    const modelled: ConnectReadScope[] = [
      "slack.search",
      "slack.channel.history",
      "gmail.search",
      "gmail.message.read",
      "calendar.events.read",
    ]
    const requested = permission("openwork.connect.read")?.scopes as string[] | undefined
    expect(requested).toBeDefined()
    for (const scope of requested ?? []) expect(modelled).toContain(scope as ConnectReadScope)
  })

  test("it requests no capability that would grant shell, filesystem, or secret access", () => {
    const forbidden = ["shell", "fs.", "filesystem", "node", "secret", "credential", "mcp", "ipc"]
    for (const entry of manifest.permissions) {
      for (const term of forbidden) expect(entry.id.toLowerCase()).not.toContain(term)
    }
  })

  test("it asks for the OpenAI key by name but never claims to read it", () => {
    expect(manifest.environment.required.map((entry) => entry.key)).toEqual(["OPENAI_API_KEY"])
    const description = manifest.environment.required[0] as { description?: string }
    expect(description.description).toContain("never receives the key")
  })

  test("microphone use is disclosed", () => {
    expect(permission("audio.microphone")).toBeDefined()
    expect(manifest.privacy.data_handled).toContain("microphone-audio")
  })

  test("every network host it may reach is disclosed as a third party", () => {
    const hosts = (permission("network.host")?.hosts as string[] | undefined) ?? []
    const disclosed = manifest.privacy.third_parties.map((entry) => entry.host)
    for (const host of disclosed) expect(hosts).toContain(host)
    expect(hosts).toEqual(["api.openai.com"])
  })

  test("every declared entrypoint is reachable through a contribution", () => {
    const surfaceKeys = new Set(Object.keys(manifest.entrypoints.surfaces))
    const referenced = new Set(
      manifest.contributions
        .filter((entry) => entry.type === "surface")
        .map((entry) => entry.entrypoint as string),
    )
    expect([...surfaceKeys].sort()).toEqual([...referenced].sort())
    const hasBackground = manifest.contributions.some((entry) => entry.type === "background")
    expect(hasBackground).toBe(manifest.entrypoints.background !== undefined)
  })

  test("every global shortcut contribution is listed in the permission", () => {
    const declared = manifest.contributions
      .filter((entry) => entry.type === "shortcut" && entry.global === true)
      .map((entry) => entry.id)
    const granted = (
      (permission("desktop.globalShortcut")?.shortcuts as Array<{ id: string }> | undefined) ?? []
    ).map((entry) => entry.id)
    expect(declared.sort()).toEqual(granted.sort())
  })

  test("contribution ids are unique across every type", () => {
    const ids = manifest.contributions.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the transcript setting is off by default", () => {
    const setting = manifest.contributions.find((entry) => entry.id === "show-transcript")
    expect(setting?.default).toBe(false)
  })

  test("retention is session-scoped, not persistent, for transcripts", () => {
    const privacy = manifest.privacy as unknown as {
      retention: { policy: string; description: string }
    }
    expect(privacy.retention.policy).toBe("session")
    expect(privacy.retention.description).toContain("dropped when you stop")
  })
})
