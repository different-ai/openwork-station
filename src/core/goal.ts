import type { StationGoal } from "./types.js"

// Goal proposal and the spoken yes/no.
//
// Station says what it intends to do before it does it. The user can decline,
// and declining must be as easy as accepting — otherwise "proposing" is just a
// slower way of doing it anyway.

/** A proposal the user never answers expires rather than sitting on screen. */
export const GOAL_TTL_MS = 45_000

export type GoalDecision = "accept" | "decline" | null

const ACCEPT = /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|look into it|research it|please do|continue|start it)\b/
const DECLINE = /^(no|nope|nah|not now|don'?t|do not|stop|skip it|leave it|cancel|never mind)\b/

/**
 * Read a spoken answer to a pending goal.
 *
 * Only short utterances count. A long sentence that happens to start with "no"
 * is the user talking to someone else, not answering Station, and treating it
 * as an answer is how an ambient app becomes something you fight.
 */
export function spokenGoalDecision(utterance: string): GoalDecision {
  const clean = utterance
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean || clean.length > 90) return null
  if (ACCEPT.test(clean)) return "accept"
  if (DECLINE.test(clean)) return "decline"
  return null
}

export function goalIsLive(goal: StationGoal | null, now: number): boolean {
  return goal !== null && goal.status === "proposed" && goal.expiresAt > now
}

export function expireGoal(goal: StationGoal | null, now: number): StationGoal | null {
  if (goal === null) return null
  if (goal.status === "proposed" && goal.expiresAt <= now) return null
  return goal
}
