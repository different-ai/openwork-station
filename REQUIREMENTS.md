# What Station needs, and what you get without it

Station works in layers. Each one needs something from you, and each one works
on its own — so you can stop at any layer and still have a working app, rather
than needing everything configured before anything happens.

This page says exactly what each layer needs, what you see when you have it,
and what you see when you don't.

---

## At a glance

| Layer | Needs | Without it |
|---|---|---|
| **1. Install** | Nothing | — |
| **2. Turn on** | `OPENAI_API_KEY` in OpenWork | Stays at *needs setup*; the **Turn on** button is unavailable |
| **3. Listen and transcribe** | macOS microphone permission | The island reports **Error** and says permission was refused |
| **4. Notice opportunities** | Layers 2–3 | — |
| **5. Research and cite** | OpenWork Cloud sign-in + at least one authorized source | The island says **No sources**; no card is produced |
| **6. Start a thread** | Layer 5, plus your explicit confirmation | Enter does nothing without a live confirmation |

Everything below layer 5 works today with just an OpenAI key. Layer 5 is the
one that needs OpenWork Cloud, and it is the one currently unproven end to end.

---

## 1. Install — needs nothing

Paste `https://github.com/different-ai/openwork-station` into
**Settings → Apps** and press **Look up**.

OpenWork reads the manifest at the released commit, downloads the package, and
verifies it. **No Station code runs during this step.** You review what it asks
for, then install.

It installs **switched off**. That is deliberate, not an unfinished state:
installing an app never starts its microphone.

## 2. Turn it on — needs an OpenAI API key

**What:** `OPENAI_API_KEY`
**Where:** OpenWork → **Settings → Environment**
**Get one:** <https://platform.openai.com/api-keys>

Station uses it for two things: streaming speech to a transcription model, and
deciding whether a moment is worth researching.

**Station never receives this key.** OpenWork holds it and mints a short-lived
credential when Station asks for a realtime session. Station is told only
whether the key is *configured* — there is no capability in the platform that
returns an environment value to an app.

**Without it:** the app card shows *needs setup* and lists this requirement with
Station's own explanation of what it unlocks. **Turn on** stays unavailable
until it is set. Set it, and the card updates on the next refresh.

## 3. Listening — needs microphone permission

**What:** macOS microphone access for OpenWork
**Where:** System Settings → Privacy & Security → Microphone

macOS asks the first time Station starts listening. If you refuse, or refused
earlier for OpenWork, grant it there and restart OpenWork.

Station's `audio.microphone` permission is what lets it *ask* — the operating
system still decides. Both have to say yes. The host also refuses capture
unless Station has a visible surface, so the microphone cannot be live with
nothing on screen.

**Without it:** the island shows **Error** with the reason. Nothing is recorded
and nothing is sent.

## 4. Noticing opportunities — needs layers 2 and 3

With a key and a microphone, Station transcribes what you say and runs a
lightweight detection pass **while you are still speaking** — it does not wait
for a silence.

When it notices something worth looking into, it proposes a goal in one
sentence: *"I'll check whether Thursday is already booked."* You say yes or no.
Nothing is researched until you accept.

**What you'll see:** the island moves through **Listening → Thinking**, and a
proposal appears with Yes/No. This works with nothing connected.

## 5. Research and cited cards — needs OpenWork Cloud and a source

**What:** a profile signed into OpenWork Cloud with at least one authorized
source — Slack, Gmail, or Google Calendar
**Where:** OpenWork → **Settings → Connect**

When you accept a goal, Station asks the OpenWork Connect broker to search your
connected sources. The broker is read-only and limited to the three scopes
Station declared: `slack.search`, `gmail.search`, `calendar.events.read`.
Station never sees a provider credential and cannot run an arbitrary query.

**Without it:** the island says **No sources** and produces nothing. It does not
fall back to a card written from the model's imagination — a card can only cite
records that were actually retrieved, and cited titles are matched back against
real results before the card is built.

That behaviour is the honest one, but it does mean an unconnected Station never
shows you a researched card. If you see **No sources**, this is the layer you
are missing.

> **This is the layer currently unproven end to end.** The broker path is
> covered by tests, and Station correctly reports the unavailable case. A real
> cited retrieval from a live Slack, Gmail, or Calendar account has not been
> demonstrated, and is not claimed.

## 6. Starting a thread — needs a deliberate confirmation

Pressing Enter on a card, or clicking **Start thread**, hands the prepared goal
to OpenWork.

This needs a **fresh user gesture**: a single-use token the host mints on real
input, valid for seconds, bound to Station specifically. Station holds at most
one and drops it the moment it is spent or expires.

**Without a live gesture:** the action is refused with *"Confirm this to start a
thread."* Station cannot start a thread on its own, however confident it is —
and this is enforced by the host, not by Station's good behaviour.

You separately choose whether a transcript excerpt goes along. The whole ambient
transcript is never attached; even when you say yes, it is a bounded window of
the recent tail.

---

## Where each thing is stored

| | Where | Who can read it |
|---|---|---|
| `OPENAI_API_KEY` | OpenWork's user-level environment store, atomic `0o600` writes | OpenWork only. Station gets configured/missing. |
| Realtime credential | Minted per session, expires in minutes | Station, briefly |
| Connected-source access | OpenWork Cloud | The broker only. Station gets normalized read-only results. |
| Transcript | Memory, for the listening session | Station. Dropped when you stop. |
| Dismissed cards, transcript preference | App storage, 1 MB quota | Station |

Nothing Station holds survives a stop except your dismissed-card list and your
transcript display preference.

## Reading the island

| It says | It means |
|---|---|
| **Off** | Not listening |
| **Connecting** | Opening a realtime session |
| **Listening** | Transcribing |
| **Thinking** | Deciding whether this moment is worth researching |
| **Looking** | Researching an accepted goal |
| **Ready** | A card is waiting |
| **No sources** | Nothing is connected, or the connection failed — layer 5 |
| **Nothing yet** | Connected and searched, but nothing relevant found |
| **Error** | Something failed; the message says what |

**No sources** and **Nothing yet** are deliberately different. One is a setup
problem you can fix; the other means Station looked and there was nothing
useful. Showing the same thing for both teaches people to ignore the app.

Station is also designed never to sit on **Thinking**: a detection pass that
does not answer within its timeout is abandoned and the island returns to
**Listening**.

## Requirements are visible in the app too

The **Settings → Apps** card for any installed app lists everything it still
needs, with the app author's own description of what each unlocks and a link to
where to get it, plus a **Set it** button. That is generic — it reads the app's
manifest — so any app you install explains itself the same way.
