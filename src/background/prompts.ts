import type { StationGoal } from "../core/types.js"

// Prompts and response schemas.
//
// Both calls are structured: the host validates the model's answer against the
// schema before Station sees it, so the runtime never parses prose or guesses
// at a shape. Versioning them here means a prompt change is a reviewable diff
// rather than a string edited in the middle of the loop.
//
// Neither prompt asks the model to explain its reasoning. Station persists
// decisions, not chains of thought: what it decided and why, in one sentence a
// person would recognise, is what the card needs and all that is kept.

export const DETECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["worthwhile", "focus", "subject", "statement", "reason"],
  properties: {
    worthwhile: {
      type: "boolean",
      description: "True only when acting now would genuinely help.",
    },
    focus: {
      type: "string",
      enum: [
        "prior_conversation",
        "person",
        "commitment",
        "calendar",
        "follow_up",
        "decision",
        "next_step",
      ],
    },
    subject: { type: "string", maxLength: 80 },
    statement: {
      type: "string",
      maxLength: 120,
      description: 'First person, one sentence, starting "I\'ll".',
    },
    reason: { type: "string", maxLength: 160 },
  },
} as const

export const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "summary", "reason", "confidence", "cited"],
  properties: {
    kind: { type: "string", enum: ["context", "preparation", "commitment", "conflict"] },
    title: { type: "string", maxLength: 80 },
    summary: { type: "string", maxLength: 400 },
    reason: { type: "string", maxLength: 200 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    cited: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
      description: "Titles copied exactly from the supplied records. Never invent one.",
    },
  },
} as const

export function detectionPrompt(context: string): string {
  return [
    "You are watching a live work conversation to notice when preparing something would help.",
    "",
    "Say it is worthwhile only when all of these hold:",
    "- there is a specific person, commitment, deadline, decision, or meeting involved",
    "- looking it up in the user's own messages, mail, or calendar would add something they do not already have in front of them",
    "- it is actionable now, not a general topic",
    "",
    "Say it is not worthwhile for small talk, thinking aloud, repetition of something",
    "already covered, or anything where the answer is already in what was just said.",
    "It is far better to stay quiet than to interrupt with something obvious.",
    "",
    'When it is worthwhile, write `statement` as one first-person sentence beginning "I\'ll",',
    "describing exactly what you would go and find out.",
    "",
    "Recent conversation:",
    context.slice(-4_000),
  ].join("\n")
}

export function researchPrompt(
  goal: StationGoal,
  records: ReadonlyArray<{ scope: string; title: string; excerpt: string; occurredAt?: string }>,
): string {
  return [
    `The user accepted this: "${goal.statement}"`,
    "",
    "Below are records retrieved from their connected sources. Use only these.",
    "Cite by copying titles exactly into `cited`. Do not invent a source, and do not",
    "cite one you did not actually use.",
    "",
    "If these records do not actually answer the goal, set confidence below 0.3 —",
    "a card the user has to check is worse than no card.",
    "",
    "Write the summary as something a colleague would say: what was found, and what it",
    "means for the thing they are about to do.",
    "",
    "Records:",
    ...records.map(
      (record, index) =>
        `${index + 1}. [${record.scope}] ${record.title}${record.occurredAt ? ` (${record.occurredAt})` : ""}\n   ${record.excerpt.slice(0, 400)}`,
    ),
  ].join("\n")
}
