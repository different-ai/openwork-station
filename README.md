# OpenWork Station

An ambient assistant, distributed as an **OpenWork App**.

While listening is switched on, Station notices what you are working on,
prepares useful context at the edge of your screen, and hands it to OpenWork
when you accept it. It never acts on your behalf: it researches, ranks, and
drafts, and every outward step stays yours.

Station is also the reference implementation for the OpenWork Apps platform. It
is a genuine third-party consumer of the public contract — it imports nothing
from OpenWork, uses no monorepo path aliases, and reaches the host only through
the versioned capability broker. If Station can be built this way, so can
anything else.

## Requirements

Station works in layers, and each one works on its own. In short: installing
needs nothing, turning it on needs an `OPENAI_API_KEY` that OpenWork holds on
your behalf, listening needs macOS microphone permission, and researched cards
need OpenWork Cloud with at least one authorized source.

[**REQUIREMENTS.md**](REQUIREMENTS.md) says exactly what each layer needs, what
you see when you have it, and what you see when you do not — including why
**No sources** and **Nothing yet** are deliberately different messages.

## Status

Early, but installable. [**v0.1.0**](https://github.com/different-ai/openwork-station/releases/tag/v0.1.0)
is published, and OpenWork installs it from this repository's URL — that path is
proven end to end against the real release.

The host platform that installs it is in review as
[different-ai/openwork#3313](https://github.com/different-ai/openwork/pull/3313)
and is not on `dev` yet, so you need a checkout of that branch. See
[LOCAL-TESTING.md](LOCAL-TESTING.md).

What is **not** proven: researched cards from live Slack, Gmail, or Calendar.
That needs OpenWork Cloud with an authorized source, and until then Station
correctly reports **No sources** rather than inventing one. See
[REQUIREMENTS.md](REQUIREMENTS.md).

## What Station asks for, and why

| Permission | Why |
|---|---|
| `audio.microphone` | Transcribe what you say while listening is on |
| `ai.realtime` | Stream that speech to a transcription model |
| `ai.inference.transient` | Decide whether a moment is worth researching |
| `openwork.connect.read` | Read-only Slack search, Gmail search, and calendar events |
| `runtime.background.continuous` | Notice things while you work, not only while a window is open |
| `openwork.threads.start` | Hand a prepared goal to OpenWork when you accept it |
| `openwork.attachments.create` | Attach the relevant excerpt, if you choose to include it |
| `desktop.floatingSurface` | Keep a small island at the edge of the screen |
| `desktop.globalShortcut` | Start and stop listening without leaving your current app |
| `network.host` | Reach `api.openai.com`, and nothing else |
| `storage.app` | Remember dismissed cards and your transcript preference |

Station **never receives your OpenAI key**. OpenWork holds it, mints a
short-lived realtime credential, and hands Station that. Station is told only
whether the key is configured.

Starting a thread and creating an attachment additionally require a *fresh user
gesture* — a token the host issues on real input and that expires in seconds.
Station cannot start a thread on its own, however confident it is.

## Privacy

- Audio is transcribed only while listening is on, and is never written to disk.
- The transcript lives in memory for the session and is dropped when you stop.
- **The whole transcript is never attached to a thread.** You choose whether an
  excerpt is included, and even then it is a bounded window of the recent tail.
- Audit records carry what happened — never transcript text, connected-record
  contents, or secret values. `tests/core.test.ts` asserts this.

## Architecture

```
src/core/         portable logic, no DOM and no host coupling
  types.ts          Station's own domain types
  capabilities.ts   the slice of the App protocol Station uses
  relevance.ts      decay, contextual boost, dedup by source identity
  history.ts        card navigation and dismissal
  goal.ts           "I'll look into X" proposals and the spoken yes/no
  transcript.ts     reconciling interleaved realtime partials and finals
  scout.ts          the continuous opportunity scout: rate limits, staleness,
                    duplicate suppression, budgets, and the guarantee that
                    "deciding" always ends
  handoff.ts        building the thread payload, and the transcript choice
src/surfaces/     the floating island and card UI
src/background/   the runtime that drives transcription and research
```

`src/core` is pure and covered by tests that need no network, no microphone, and
no host. The parts that genuinely need those are the parts that get live
evidence, not fixtures pretending to be live evidence.

### Why the scout is a separate, pure module

Station must not wait for you to stop speaking — waiting for a long silence is
what makes an ambient assistant feel dead. So detection runs *during* speech, on
a bounded schedule. That schedule has to be right under pressure: continuous
talking, a lost model reply, a workspace switch mid-request, a topic that
recurs every few seconds.

Keeping it pure means all of that is testable directly: that a second pass is
refused until the interval elapses, that a lost reply cannot wedge the app on
"deciding", that a new session inherits none of the previous session's budget,
and that stopping invalidates work already in flight so a slow answer can never
surface a card after you stopped listening.

## Development

```bash
pnpm install
pnpm test        # bun test
pnpm typecheck
```

Validate and package with the OpenWork app tools:

```bash
openwork-app validate openwork.app.json
openwork-app pack --root . --out dist/openwork-station-0.1.0.owapp \
  --repository https://github.com/different-ai/openwork-station \
  --tag v0.1.0 --commit "$(git rev-parse HEAD)"
```

Those tools are workspace packages in OpenWork and are **not published to npm**.
Run them from a local OpenWork checkout — `scripts/package.mjs` finds them via
`--tools` or `OPENWORK_REPO`, and says where it looked if it cannot.

## License

MIT. See [LICENSE](LICENSE).
