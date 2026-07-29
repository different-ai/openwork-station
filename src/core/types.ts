// Station's own domain types.
//
// Nothing here imports from OpenWork. Station is a third-party consumer of the
// public App contract: it talks to the host only through the capability broker,
// and it owns every type describing its own behaviour. If a type in this file
// looked like a host type, that would be a sign Station had quietly become part
// of OpenWork again.

import type { ConnectReadScope } from "./capabilities.js"

/** Where a piece of evidence behind a suggestion came from. */
export type StationSource = {
  scope: ConnectReadScope
  title: string
  url?: string
  occurredAt?: string
  author?: string
}

export type StationSuggestionKind = "context" | "preparation" | "commitment" | "conflict"

/** One prepared card. Produced only from real model or connected-source output. */
export type StationSuggestion = {
  id: string
  kind: StationSuggestionKind
  title: string
  summary: string
  /** Why Station thinks this is worth the user's attention right now. */
  reason: string
  /** 0..1 confidence at creation time, before decay. */
  relevance: number
  sources: StationSource[]
  createdAt: number
  /** Transcript span this was derived from, for honest provenance. */
  transcriptSpan?: { from: number; to: number }
}

/** A suggestion with its decayed, context-adjusted score applied. */
export type RankedSuggestion = StationSuggestion & { effectiveRelevance: number }

/**
 * An intention Station proposes before doing deeper work.
 *
 * The user sees "I'll look into X" and can decline. Research does not start
 * until the goal is accepted, so the app never spends connected-source budget
 * on something the user did not want.
 */
export type StationGoal = {
  id: string
  title: string
  /** The sentence shown to the user, in first person. */
  statement: string
  reason: string
  focus: StationGoalFocus
  status: "proposed" | "accepted" | "researching" | "declined"
  createdAt: number
  /** Proposals go stale; an unanswered goal disappears rather than lingering. */
  expiresAt: number
}

export type StationGoalFocus =
  | "prior_conversation"
  | "person"
  | "commitment"
  | "calendar"
  | "follow_up"
  | "decision"
  | "next_step"

/**
 * What Station is doing, as the user would describe it.
 *
 * `deciding` is deliberately bounded elsewhere: a state machine that can sit on
 * "deciding" forever is the bug this vocabulary exists to make visible.
 */
export type StationPhase =
  | "disabled"
  | "idle"
  | "connecting"
  | "listening"
  | "deciding"
  | "researching"
  | "ready"
  | "unavailable"
  | "error"

export type StationInteractionMode = "passive" | "active"

/** Why research could not produce anything, so the UI can say which. */
export type StationUnavailableReason =
  | "no_useful_context"
  | "no_connections"
  | "connection_failed"
  | "budget_exhausted"
  | null

export type StationState = {
  phase: StationPhase
  mode: StationInteractionMode
  listening: boolean
  transcript: string
  partialTranscript: string
  suggestions: RankedSuggestion[]
  selectedId: string | null
  goal: StationGoal | null
  /** Transcript UI is opt-in and independent of whether cards are shown. */
  transcriptVisible: boolean
  unavailable: StationUnavailableReason
  error: string | null
}

export const INITIAL_STATION_STATE: StationState = {
  phase: "idle",
  mode: "passive",
  listening: false,
  transcript: "",
  partialTranscript: "",
  suggestions: [],
  selectedId: null,
  goal: null,
  transcriptVisible: false,
  unavailable: null,
  error: null,
}
