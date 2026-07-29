import type { RankedSuggestion, StationGoal } from "./types.js"

// Handing a prepared suggestion to OpenWork.
//
// Starting a thread is a privileged, user-intent action. This module builds the
// payload; the host refuses it without a fresh gesture token, so nothing here
// can start a thread on its own.
//
// The privacy rule is the important part: the whole ambient transcript is never
// attached. The user chooses whether an excerpt goes along, and the excerpt is
// a bounded window even when they say yes.

export const MAX_EXCERPT_CHARACTERS = 1_200

export type HandoffInput = {
  suggestion: RankedSuggestion
  goal: StationGoal | null
  sessionId: string
  workspaceId: string | null
  appVersion: string
  /** The user's explicit choice about the transcript, not a default. */
  includeTranscript: boolean
  transcriptExcerpt: string
  now: number
}

export type HandoffAttachment = {
  filename: string
  contentType: "text/markdown"
  content: string
}

export type Handoff = {
  title: string
  goal: string
  summary: string
  provenance: Array<{ scope: string; title: string; url?: string; occurred_at?: string }>
  appSessionId: string
  attachment: HandoffAttachment | null
  /** Safe to log: no transcript body, no connected-record contents. */
  audit: {
    appVersion: string
    workspaceId: string | null
    suggestionId: string
    sourceCount: number
    transcriptIncluded: boolean
    at: number
  }
}

function boundedExcerpt(value: string): string {
  return value.trim().slice(-MAX_EXCERPT_CHARACTERS).trim()
}

export function buildHandoff(input: HandoffInput): Handoff {
  const { suggestion, goal } = input
  const excerpt = input.includeTranscript ? boundedExcerpt(input.transcriptExcerpt) : ""

  const summaryParts = [suggestion.summary, `Why now: ${suggestion.reason}`]
  if (suggestion.sources.length > 0) {
    summaryParts.push(
      ["Context Station found:", ...suggestion.sources.map((source) => `- ${source.title}`)].join("\n"),
    )
  } else {
    // Say so rather than implying research happened. A card with no sources is
    // a model suggestion, and the thread should not pretend otherwise.
    summaryParts.push("Station found no connected-source evidence for this one.")
  }

  return {
    title: suggestion.title,
    goal: goal?.statement ?? `Help me with: ${suggestion.title}`,
    summary: summaryParts.join("\n\n"),
    provenance: suggestion.sources.map((source) => ({
      scope: source.scope,
      title: source.title,
      ...(source.url === undefined ? {} : { url: source.url }),
      ...(source.occurredAt === undefined ? {} : { occurred_at: source.occurredAt }),
    })),
    appSessionId: input.sessionId,
    attachment:
      excerpt.length > 0
        ? {
            filename: `station-context-${input.now}.md`,
            contentType: "text/markdown",
            content: [
              `# Station context`,
              ``,
              `Captured for: ${suggestion.title}`,
              ``,
              `## Relevant excerpt`,
              ``,
              excerpt,
            ].join("\n"),
          }
        : null,
    audit: {
      appVersion: input.appVersion,
      workspaceId: input.workspaceId,
      suggestionId: suggestion.id,
      sourceCount: suggestion.sources.length,
      transcriptIncluded: excerpt.length > 0,
      at: input.now,
    },
  }
}
