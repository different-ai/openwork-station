import type { RankedSuggestion } from "./types.js"

// Card navigation and dismissal.
//
// Kept as pure functions on purpose: the flicker bug this replaces came from
// deciding the next selection inside a render effect, where a dismissal and a
// re-rank could race. Here, one call produces the whole next selection state.

export type HistoryDirection = "older" | "newer"

export type DismissalResult = {
  suggestions: RankedSuggestion[]
  selectedId: string | null
  /** True when nothing is left to show, so the surface returns to passive. */
  returnToPassive: boolean
}

export function dismissSuggestion(
  suggestions: readonly RankedSuggestion[],
  selectedId: string | null,
  dismissedId: string | null,
): DismissalResult {
  const target = dismissedId ?? selectedId
  const remaining = suggestions.filter((suggestion) => suggestion.id !== target)
  return {
    suggestions: remaining,
    selectedId: remaining[0]?.id ?? null,
    returnToPassive: remaining.length === 0,
  }
}

/**
 * Move through history without wrapping.
 *
 * Clamping rather than wrapping is deliberate: arrow keys at the end of the
 * list should feel like the end of the list, not silently jump the user back to
 * a card they just dismissed past.
 */
export function selectAdjacent(
  suggestions: readonly RankedSuggestion[],
  selectedId: string | null,
  direction: HistoryDirection,
): string | null {
  if (suggestions.length === 0) return null
  const currentIndex = Math.max(
    0,
    suggestions.findIndex((suggestion) => suggestion.id === selectedId),
  )
  const nextIndex =
    direction === "older"
      ? Math.min(suggestions.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1)
  return suggestions[nextIndex]?.id ?? null
}
