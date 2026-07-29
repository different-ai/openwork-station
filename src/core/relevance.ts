import type { RankedSuggestion, StationSuggestion } from "./types.js"

// Ranking and deduplication.
//
// Two properties matter more than the exact numbers:
//
//   * A suggestion decays. Something surfaced four minutes ago is less relevant
//     than something surfaced now, so the card at the front of the stack tracks
//     the conversation instead of whatever happened to arrive first.
//   * A corrected suggestion replaces its predecessor rather than joining it.
//     Identity is the underlying source, not the wording, so re-researching the
//     same calendar event updates one card instead of producing two.

const HALF_LIFE_MS = 4 * 60 * 1_000
const MAX_SUGGESTIONS = 8
const MINIMUM_RELEVANCE = 0.08
const MAX_CONTEXT_BOOST = 0.16
const BOOST_PER_MATCH = 0.025

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function significantWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  )
}

/** Small lift when a suggestion echoes what is currently being said. */
function contextualBoost(suggestion: StationSuggestion, transcript: string): number {
  const spoken = significantWords(transcript)
  if (spoken.size === 0) return 0
  const words = significantWords(`${suggestion.title} ${suggestion.summary} ${suggestion.reason}`)
  let matches = 0
  for (const word of words) if (spoken.has(word)) matches += 1
  return Math.min(MAX_CONTEXT_BOOST, matches * BOOST_PER_MATCH)
}

export function effectiveRelevance(
  suggestion: StationSuggestion,
  transcript: string,
  now: number,
): number {
  const age = Math.max(0, now - suggestion.createdAt)
  const decay = Math.pow(0.5, age / HALF_LIFE_MS)
  return clamp(suggestion.relevance * decay + contextualBoost(suggestion, transcript))
}

/**
 * Stable identity for deduplication.
 *
 * A suggestion backed by a source URL is *that source's* card, whatever the
 * model called it this time. Only when there is no source does the title become
 * the identity.
 */
function identity(suggestion: StationSuggestion): string {
  const source = suggestion.sources.map((entry) => entry.url?.trim().toLowerCase()).find(Boolean)
  if (source) return `${suggestion.kind}:source:${source}`
  return `${suggestion.kind}:local:${suggestion.title.toLowerCase().trim()}`
}

export function rankSuggestions(
  current: readonly StationSuggestion[],
  incoming: readonly StationSuggestion[],
  transcript: string,
  now: number,
): RankedSuggestion[] {
  const byIdentity = new Map<string, StationSuggestion>()
  for (const suggestion of [...current, ...incoming]) {
    const key = identity(suggestion)
    const previous = byIdentity.get(key)
    if (
      !previous ||
      suggestion.createdAt >= previous.createdAt ||
      suggestion.relevance > previous.relevance
    ) {
      byIdentity.set(key, suggestion)
    }
  }
  return [...byIdentity.values()]
    .map((suggestion) => ({
      ...suggestion,
      effectiveRelevance: effectiveRelevance(suggestion, transcript, now),
    }))
    .filter((suggestion) => suggestion.effectiveRelevance >= MINIMUM_RELEVANCE)
    .sort(
      (left, right) =>
        right.effectiveRelevance - left.effectiveRelevance || right.createdAt - left.createdAt,
    )
    .slice(0, MAX_SUGGESTIONS)
}
