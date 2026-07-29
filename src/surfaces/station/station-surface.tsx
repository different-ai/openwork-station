import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { dismissSuggestion, selectAdjacent } from "../../core/history.js"
import { INITIAL_STATION_STATE, type StationState } from "../../core/types.js"

// The Station surface.
//
// A small island at the edge of the screen, and a card that slides out from
// behind it. Two interaction rules shape most of this file:
//
//   * **Station does not own the keyboard.** It is ambient: the user is
//     usually typing into something else. Keys are handled only while Station
//     genuinely has focus, and Escape closes what Station has open rather than
//     bubbling into OpenWork.
//   * **Enter is a deliberate act.** It starts a real thread, so it fires only
//     when a suggestion is showing and Station is the focused surface — never
//     as a stray keystroke that happened to land here.

type Message =
  | { type: "state"; state: StationState }
  | { type: "goal-progress"; percent: number }

export function StationSurface() {
  const [state, setState] = useState<StationState>(INITIAL_STATION_STATE)
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)

  // The background runtime owns the state; the surface renders it and sends
  // intent back. Keeping one direction of truth is what stops the card and the
  // island disagreeing about what is happening.
  const post = useCallback((message: Record<string, unknown>) => {
    window.parent.postMessage({ source: "openwork-station", ...message }, "*")
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent<Message>) => {
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type === "state") setState(data.state)
    }
    window.addEventListener("message", onMessage)
    post({ type: "surface-ready" })
    return () => window.removeEventListener("message", onMessage)
  }, [post])

  const selected = useMemo(
    () => state.suggestions.find((entry) => entry.id === state.selectedId) ?? null,
    [state.suggestions, state.selectedId],
  )

  const dismiss = useCallback(() => {
    if (!selected) return
    const next = dismissSuggestion(state.suggestions, state.selectedId, selected.id)
    // Applied locally as well as reported, so the card leaves immediately
    // rather than after a round trip. That round-trip delay is what read as
    // flicker when a second dismissal arrived mid-transition.
    setState((current) => ({
      ...current,
      suggestions: next.suggestions,
      selectedId: next.selectedId,
    }))
    post({ type: "dismiss", id: selected.id })
  }, [post, selected, state.suggestions, state.selectedId])

  const navigate = useCallback(
    (direction: "older" | "newer") => {
      const nextId = selectAdjacent(state.suggestions, state.selectedId, direction)
      if (nextId === state.selectedId) return
      setState((current) => ({ ...current, selectedId: nextId }))
      post({ type: "select", id: nextId })
    },
    [post, state.suggestions, state.selectedId],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ambient means ambient. Without focus, every key belongs to whatever the
      // user is actually working in.
      if (!focused) return

      if (event.key === "Escape") {
        // Escape closes what Station has open, in order of what is most
        // "on top", and never reaches the host — a stray Escape must not open
        // or navigate OpenWork.
        if (captionsOpen) {
          setCaptionsOpen(false)
        } else if (selected) {
          dismiss()
        } else {
          post({ type: "blur" })
        }
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (!selected) return

      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        navigate("older")
        event.preventDefault()
        return
      }
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        navigate("newer")
        event.preventDefault()
        return
      }
      if (event.key === "Enter") {
        // A real thread. Deliberate, focused, with something selected.
        post({ type: "start-thread", id: selected.id })
        event.preventDefault()
      }
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [captionsOpen, dismiss, focused, navigate, post, selected])

  const phaseLabel = describePhase(state)

  return (
    <div
      className="station-stage"
      ref={rootRef}
      tabIndex={-1}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      {selected ? (
        <article className="station-card" aria-live="polite">
          <header>
            <span className="station-priority-dot" aria-hidden />
            <h1>{selected.title}</h1>
          </header>
          <p>{selected.summary}</p>
          <p className="station-card-meta">{selected.reason}</p>
          {selected.sources.length > 0 ? (
            <ul className="station-evidence">
              {selected.sources.map((source) => (
                <li key={`${source.scope}:${source.title}`}>{source.title}</li>
              ))}
            </ul>
          ) : null}
          <footer className="station-card-footer">
            <span className="station-history">
              {state.suggestions.indexOf(selected) + 1} of {state.suggestions.length}
            </span>
            <div className="station-decisions">
              <button type="button" className="station-not-now" onClick={dismiss}>
                Not now <kbd>Esc</kbd>
              </button>
              <button
                type="button"
                className="station-enter"
                onClick={() => post({ type: "start-thread", id: selected.id })}
              >
                Start thread <kbd>⏎</kbd>
              </button>
            </div>
          </footer>
        </article>
      ) : null}

      {state.goal ? (
        <div className="station-goal">
          <div>
            <span aria-hidden />
            <p>{state.goal.statement}</p>
          </div>
          <div className="station-decisions">
            <button type="button" className="station-not-now" onClick={() => post({ type: "decline-goal" })}>
              No
            </button>
            <button type="button" className="station-enter" onClick={() => post({ type: "accept-goal" })}>
              Yes
            </button>
          </div>
        </div>
      ) : null}

      <div className="station-island">
        <button
          type="button"
          className="station-pill"
          aria-label={state.listening ? "Stop listening" : "Start listening"}
          aria-pressed={state.listening}
          onClick={() => post({ type: "toggle-listening" })}
        >
          <span className="station-mic" data-listening={state.listening} aria-hidden />
          <span className="station-mode-toggle">{phaseLabel}</span>
          {state.phase === "deciding" || state.phase === "researching" ? (
            <span className="station-activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </button>

        {/*
          The transcript toggle lives below the island and opens downward, so it
          can never sit over the card, which comes out on the left.
        */}
        {state.transcriptVisible ? (
          <button
            type="button"
            className="station-caption-toggle"
            aria-expanded={captionsOpen}
            onClick={() => setCaptionsOpen((open) => !open)}
          >
            Transcript
          </button>
        ) : null}
      </div>

      {state.transcriptVisible && captionsOpen ? (
        <section className="station-caption">
          <header>
            <span className="station-caption-live-dot" aria-hidden />
            <button type="button" onClick={() => post({ type: "clear-transcript" })}>
              Clear
            </button>
            <button type="button" className="is-on" onClick={() => setCaptionsOpen(false)}>
              Hide
            </button>
          </header>
          <p>
            {state.transcript}
            {state.partialTranscript ? <mark>{state.partialTranscript}</mark> : null}
          </p>
        </section>
      ) : null}

      {state.error ? <p className="station-error">{state.error}</p> : null}
    </div>
  )
}

/**
 * What the island says it is doing.
 *
 * Every state is distinguishable, including the unhelpful ones. "Nothing useful
 * here" and "your sources are not connected" are different problems with
 * different fixes, and an ambient app that shows the same shrug for both trains
 * people to ignore it.
 */
function describePhase(state: StationState): string {
  if (!state.listening) return "Off"
  switch (state.phase) {
    case "connecting":
      return "Connecting"
    case "listening":
      return "Listening"
    case "deciding":
      return "Thinking"
    case "researching":
      return "Looking"
    case "ready":
      return "Ready"
    case "unavailable":
      return state.unavailable === "no_connections"
        ? "No sources"
        : state.unavailable === "connection_failed"
          ? "Source failed"
          : "Nothing yet"
    case "error":
      return "Error"
    default:
      return "Listening"
  }
}
