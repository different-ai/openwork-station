#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Build the release package.
//
// Packs from a staging directory holding exactly what ships — the manifest, the
// built bundles, the icon, and the licence. `openwork-app pack` would otherwise
// take the whole working tree, which would put source, tests, and the lockfile
// inside every user's install.
//
// This is a deliberate choice rather than a size optimisation: an OpenWork App
// package is a closed, hashed file list, and the smaller that list is, the less
// there is to review and the less can silently change between releases.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const SHIPPED = ["openwork.app.json", "assets", "dist", "LICENSE"]

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith("--")) continue
  args.set(token.slice(2), process.argv[index + 1] ?? "true")
  index += 1
}

const manifest = JSON.parse(await readFile(join(root, "openwork.app.json"), "utf8"))
const version = manifest.version
const tag = args.get("tag") ?? `v${version}`
const commit =
  args.get("commit") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim()
const outDir = resolve(root, args.get("out-dir") ?? "release")
const assetName = manifest.distribution.asset.replaceAll("{version}", version)
const out = join(outDir, assetName)

// The app tools come from a local OpenWork checkout, not from npm — they are
// workspace packages and deliberately unpublished. Candidate locations, in
// order: an explicit --tools path, OPENWORK_REPO, the sibling checkout, then the
// worktree the platform branch lives in.
const toolCandidates = [
  args.get("tools"),
  process.env.OPENWORK_REPO
    ? join(process.env.OPENWORK_REPO, "packages", "app-tools", "bin", "openwork-app.mjs")
    : null,
  join(root, "..", "openwork", "packages", "app-tools", "bin", "openwork-app.mjs"),
  join(root, "..", "openwork-apps", "packages", "app-tools", "bin", "openwork-app.mjs"),
].filter((entry) => typeof entry === "string" && entry.length > 0)

const tools = toolCandidates.find((candidate) => existsSync(candidate))
if (!tools) {
  process.stderr.write(
    [
      "Could not find the OpenWork app tools.",
      "",
      "They live in an OpenWork checkout with the Apps platform branch, and are",
      "not published to npm. Point at one of:",
      "",
      "  node scripts/package.mjs --tools /path/to/openwork/packages/app-tools/bin/openwork-app.mjs",
      "  OPENWORK_REPO=/path/to/openwork node scripts/package.mjs",
      "",
      "Looked in:",
      ...toolCandidates.map((candidate) => `  ${candidate}`),
      "",
      "Build them first with:",
      "  pnpm --filter @openwork/app-contract build && pnpm --filter @openwork/app-tools build",
      "",
    ].join("\n"),
  )
  process.exit(1)
}

const staging = await mkdtemp(join(tmpdir(), "openwork-station-pkg-"))
try {
  for (const entry of SHIPPED) {
    await cp(join(root, entry), join(staging, entry), { recursive: true })
  }
  // Start from an empty release directory so a stale asset from a previous
  // version can never be mistaken for this one.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  execFileSync(
    process.execPath,
    [
      tools,
      "pack",
      "--root",
      staging,
      "--out",
      out,
      "--repository",
      manifest.repository,
      "--tag",
      tag,
      "--commit",
      commit,
    ],
    { stdio: "inherit", cwd: root },
  )

  execFileSync(process.execPath, [tools, "verify", out], { stdio: "inherit", cwd: root })
  process.stdout.write(`\nRelease assets are in ${outDir}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
