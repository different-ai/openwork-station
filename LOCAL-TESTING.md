# Testing Station in a local OpenWork

Station installs from a GitHub release. That is the real path and the one worth
testing, so this guide uses it — but everything is built from your local
checkouts, and nothing is published to npm.

## What you need

| | Path |
|---|---|
| OpenWork, on the Apps platform branch | `/Users/jalillaaraichi/.codex/worktrees/openwork-apps-host` |
| Station, on `dev` | `/Users/jalillaaraichi/openwork-station` |

The branch is `codex/openwork-apps`
([PR #3313](https://github.com/different-ai/openwork/pull/3313)). The app tools
are workspace packages in that checkout and are **not on npm** — Station reaches
into the checkout for them.

---

## 1. Build the app tools

They come from the OpenWork checkout, not a registry:

```bash
cd /Users/jalillaaraichi/.codex/worktrees/openwork-apps-host
pnpm install
pnpm --filter @openwork/app-contract build
pnpm --filter @openwork/app-tools build
```

## 2. Build and package Station

```bash
cd /Users/jalillaaraichi/openwork-station
pnpm install
pnpm build
OPENWORK_REPO=/Users/jalillaaraichi/.codex/worktrees/openwork-apps-host \
  node scripts/package.mjs
```

That writes `release/openwork-station-0.1.0.owapp` and its `.sha256`, then
verifies both. `OPENWORK_REPO` points at your OpenWork checkout; you can pass
`--tools <path-to>/openwork-app.mjs` instead if you prefer.

The script packs from a staging directory holding only the manifest, the built
bundles, the icon, and the licence — not your working tree.

## 3. Start OpenWork

```bash
cd /Users/jalillaaraichi/.codex/worktrees/openwork-apps-host
pnpm dev
```

To test against a clean profile, so you are not installing over existing state:

```bash
pnpm dev:worktree
```

## 4. Install Station

In OpenWork: **Settings → Apps** (beside Extensions, in the workspace group).

Paste:

```
https://github.com/different-ai/openwork-station
```

Press **Look up**. OpenWork resolves the latest release, reads
`openwork.app.json` at the commit that tag points to, downloads the `.owapp`,
and verifies it. **None of Station's code runs during this step.**

You should see:

- `com.openworklabs.station 0.1.0`, published by OpenWork Labs
- release `v0.1.0` and the full commit SHA
- the package digest
- eleven permissions, critical first, each with Station's own stated reason
- `OPENAI_API_KEY` listed as needed and not yet configured
- a line saying OpenWork verified where the bytes came from but **cannot verify
  who wrote them**

Press **Trust this publisher and install OpenWork Station**.

It installs **switched off**. That is intentional: installing an app never
starts its microphone.

## 5. Configure and turn it on

Station's card will show `needs setup`. Set the key it asks for in
**Settings → Environment** (`OPENAI_API_KEY`), then come back to
**Settings → Apps** and press **Turn on**.

Station never receives the key. OpenWork holds it and mints a short-lived
realtime credential when Station asks for one.

## 6. Things worth trying

| Try | Expect |
|---|---|
| Look the app up twice, install with the first review | The second candidate is unused; the first still works until it expires |
| Install, then install again | Refused — already installed |
| Wait 15+ minutes on a review, then install | Refused — the review expired, look it up again |
| Turn it off | Contributions withdraw; the runtime, shortcut, and any surface go |
| Revoke a permission from its card | The app is turned off and the permission is gone |
| Uninstall | Asks whether to keep the app's data, and records which you chose |
| Restart OpenWork | Installed state persists; a disabled app stays disabled |

## Iterating on Station itself

The host installs from releases by design, so a local change needs a release:

```bash
cd /Users/jalillaaraichi/openwork-station
# bump "version" in openwork.app.json and package.json together —
# the release workflow refuses a tag that disagrees with the manifest
pnpm build
OPENWORK_REPO=/Users/jalillaaraichi/.codex/worktrees/openwork-apps-host \
  node scripts/package.mjs
git commit -am "…" && git tag v0.1.1 && git push origin dev --tags
gh release create v0.1.1 release/* --repo different-ai/openwork-station
```

Then in OpenWork, look the repository up again. Because the new version asks for
the same permissions, the update applies immediately. If you add a permission,
it will be downloaded, verified, and **withheld** until you review the
difference — that is worth trying deliberately.

## Verifying a package by hand

```bash
cd /Users/jalillaaraichi/openwork-station
node /Users/jalillaaraichi/.codex/worktrees/openwork-apps-host/packages/app-tools/bin/openwork-app.mjs \
  verify release/openwork-station-0.1.0.owapp

shasum -a 256 release/openwork-station-0.1.0.owapp
cat release/openwork-station-0.1.0.owapp.sha256
unzip -l release/openwork-station-0.1.0.owapp
```

`unzip` works because `.owapp` is a plain ZIP. Every entry is timestamped
1980-01-01: packing is deterministic, so the digest is a function of the
contents and nothing about the machine that built it.

## What each layer needs

[REQUIREMENTS.md](REQUIREMENTS.md) is the full explainer: what every layer of
Station needs, what you see when you have it, and what you see when you do not.

The short version:

| Layer | Needs | Without it |
|---|---|---|
| Install | nothing | — |
| Turn on | `OPENAI_API_KEY` | stays at *needs setup* |
| Listening | macOS microphone permission | island shows **Error** |
| Noticing opportunities | the two above | — |
| Researched, cited cards | OpenWork Cloud + one authorized source | island shows **No sources** |
| Starting a thread | your explicit confirmation | refused, every time |

## What is not proven yet

**Connected-source research.** Station's Slack, Gmail, and Calendar queries go
through the OpenWork Connect broker, which needs a profile signed into OpenWork
Cloud with at least one authorized source. Without that, Station will correctly
report `No sources` rather than inventing a card.

**Live microphone and realtime transcription** through the new capability path
needs `OPENAI_API_KEY` configured on a signed-in profile.

Both are honest gaps, not bugs. Everything else above works today.
