// The continuous opportunity scout.
//
// Station must not wait for the user to stop speaking. Waiting for a long
// silence is what makes an ambient assistant feel dead: by the time it reacts,
// the moment is gone. So detection runs *during* speech, on a bounded schedule.
//
// Everything here is pure policy — no model calls, no timers, no I/O. The
// background runtime asks "may I run a pass now?" and this decides. That makes
// the hard parts (rate limiting, staleness, duplicate suppression, budget
// exhaustion, and the guarantee that Station never sits on "deciding" forever)
// testable without a network.

export type ScoutPolicy = {
  /** Floor between detection passes, however fast the user talks. */
  minIntervalMs: number
  /** New transcript characters required before a pass is worth spending. */
  minNewCharacters: number
  /** Detection passes allowed in flight at once. */
  maxConcurrentDetections: number
  /** Research tasks allowed in flight at once. */
  maxConcurrentResearch: number
  /** A detection pass older than this is abandoned, so `deciding` always ends. */
  decisionTimeoutMs: number
  /** A research task older than this is abandoned. */
  researchTimeoutMs: number
  /** Rolling ceiling on detection passes, to bound inference spend. */
  maxDetectionsPerMinute: number
  /** Rolling ceiling on connected-source queries. */
  maxConnectQueriesPerMinute: number
  /** How long a detected opportunity suppresses an identical one. */
  duplicateWindowMs: number
}

export const DEFAULT_SCOUT_POLICY: ScoutPolicy = {
  minIntervalMs: 4_000,
  minNewCharacters: 60,
  maxConcurrentDetections: 1,
  maxConcurrentResearch: 2,
  decisionTimeoutMs: 12_000,
  researchTimeoutMs: 25_000,
  maxDetectionsPerMinute: 10,
  maxConnectQueriesPerMinute: 20,
  duplicateWindowMs: 5 * 60_000,
}

export type DetectionDecision =
  | { run: true; window: string }
  | {
      run: false
      reason:
        | "not_listening"
        | "too_soon"
        | "insufficient_new_context"
        | "detection_in_flight"
        | "rate_limited"
    }

export type ResearchDecision =
  | { run: true }
  | { run: false; reason: "research_in_flight" | "connect_rate_limited" | "goal_not_accepted" }

type InFlight = { id: string; startedAt: number }

/**
 * Tracks what has been asked, what is running, and what is stale.
 *
 * One instance per listening session. `reset` on stop, so a new session cannot
 * inherit budgets, in-flight ids, or duplicate suppression from the last one.
 */
export class OpportunityScout {
  readonly #policy: ScoutPolicy
  #listening = false
  #lastDetectionAt = 0
  #consumedCharacters = 0
  #detections: InFlight[] = []
  #research: InFlight[] = []
  #detectionTimestamps: number[] = []
  #connectTimestamps: number[] = []
  #seen = new Map<string, number>()
  /**
   * Bumped on stop/start and on workspace change. Results carrying an older
   * epoch are dropped, so a slow answer from a previous session can never
   * surface a card after the user stopped listening.
   */
  #epoch = 0

  constructor(policy: Partial<ScoutPolicy> = {}) {
    this.#policy = { ...DEFAULT_SCOUT_POLICY, ...policy }
  }

  get epoch(): number {
    return this.#epoch
  }

  get policy(): ScoutPolicy {
    return this.#policy
  }

  startSession(now: number): void {
    this.#epoch += 1
    this.#listening = true
    this.#lastDetectionAt = now - this.#policy.minIntervalMs
    this.#consumedCharacters = 0
    this.#detections = []
    this.#research = []
    this.#detectionTimestamps = []
    this.#connectTimestamps = []
    this.#seen.clear()
  }

  /** Stop listening and invalidate everything in flight. */
  endSession(): void {
    this.#epoch += 1
    this.#listening = false
    this.#detections = []
    this.#research = []
  }

  /** A workspace or account change invalidates in-flight work bound to the old context. */
  invalidateContext(): void {
    this.#epoch += 1
    this.#detections = []
    this.#research = []
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch
  }

  /** Drop work that has outlived its timeout, so a lost reply cannot wedge a phase. */
  reapTimedOut(now: number): { detections: string[]; research: string[] } {
    const staleDetections = this.#detections.filter(
      (entry) => now - entry.startedAt >= this.#policy.decisionTimeoutMs,
    )
    const staleResearch = this.#research.filter(
      (entry) => now - entry.startedAt >= this.#policy.researchTimeoutMs,
    )
    this.#detections = this.#detections.filter((entry) => !staleDetections.includes(entry))
    this.#research = this.#research.filter((entry) => !staleResearch.includes(entry))
    return {
      detections: staleDetections.map((entry) => entry.id),
      research: staleResearch.map((entry) => entry.id),
    }
  }

  #withinRate(timestamps: number[], now: number, ceiling: number): boolean {
    const cutoff = now - 60_000
    while (timestamps.length > 0 && (timestamps[0] as number) < cutoff) timestamps.shift()
    return timestamps.length < ceiling
  }

  /**
   * Decide whether to spend a detection pass on the current context.
   *
   * `context` is the rolling window: finalized transcript plus whatever is being
   * said right now. Using the partial is the point — it is what lets Station
   * notice something mid-sentence.
   */
  shouldDetect(context: string, now: number): DetectionDecision {
    if (!this.#listening) return { run: false, reason: "not_listening" }
    if (this.#detections.length >= this.#policy.maxConcurrentDetections) {
      return { run: false, reason: "detection_in_flight" }
    }
    if (now - this.#lastDetectionAt < this.#policy.minIntervalMs) {
      return { run: false, reason: "too_soon" }
    }
    if (context.length - this.#consumedCharacters < this.#policy.minNewCharacters) {
      return { run: false, reason: "insufficient_new_context" }
    }
    if (!this.#withinRate(this.#detectionTimestamps, now, this.#policy.maxDetectionsPerMinute)) {
      return { run: false, reason: "rate_limited" }
    }
    return { run: true, window: context }
  }

  beginDetection(id: string, context: string, now: number): number {
    this.#detections.push({ id, startedAt: now })
    this.#detectionTimestamps.push(now)
    this.#lastDetectionAt = now
    this.#consumedCharacters = context.length
    return this.#epoch
  }

  endDetection(id: string): void {
    this.#detections = this.#detections.filter((entry) => entry.id !== id)
  }

  get detectionsInFlight(): number {
    return this.#detections.length
  }

  get researchInFlight(): number {
    return this.#research.length
  }

  /**
   * Suppress an opportunity already seen recently.
   *
   * The same topic recurring every few seconds while the user keeps talking
   * about it is normal; producing a card for each occurrence is not.
   */
  isDuplicate(key: string, now: number): boolean {
    const seenAt = this.#seen.get(key)
    if (seenAt === undefined) return false
    if (now - seenAt > this.#policy.duplicateWindowMs) {
      this.#seen.delete(key)
      return false
    }
    return true
  }

  noteOpportunity(key: string, now: number): void {
    this.#seen.set(key, now)
  }

  shouldResearch(goalAccepted: boolean, now: number): ResearchDecision {
    if (!goalAccepted) return { run: false, reason: "goal_not_accepted" }
    if (this.#research.length >= this.#policy.maxConcurrentResearch) {
      return { run: false, reason: "research_in_flight" }
    }
    if (!this.#withinRate(this.#connectTimestamps, now, this.#policy.maxConnectQueriesPerMinute)) {
      return { run: false, reason: "connect_rate_limited" }
    }
    return { run: true }
  }

  beginResearch(id: string, now: number): number {
    this.#research.push({ id, startedAt: now })
    return this.#epoch
  }

  endResearch(id: string): void {
    this.#research = this.#research.filter((entry) => entry.id !== id)
  }

  noteConnectQuery(now: number): void {
    this.#connectTimestamps.push(now)
  }
}

/**
 * Stable key for duplicate suppression.
 *
 * Deliberately coarse: the same intent phrased two ways should collide, because
 * the user experiences them as the same suggestion.
 */
export function opportunityKey(input: { focus: string; subject: string }): string {
  const subject = input.subject
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .sort()
    .slice(0, 6)
    .join("-")
  return `${input.focus}:${subject}`
}
