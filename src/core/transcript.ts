// Reconciling a realtime transcript.
//
// A realtime model emits interleaved partial deltas and final results for
// several items at once, out of order, sometimes repeating a final. Naively
// appending produces duplicated and shuffled text, which then poisons every
// downstream decision.
//
// This accumulator keeps items keyed and ordered by first appearance, drops
// repeated finals, and bounds total length so a long session cannot grow without
// limit.

export type TranscriptCompletion = {
  /** False when the final was empty or a duplicate of one already recorded. */
  accepted: boolean
  transcript: string
}

export class TranscriptAccumulator {
  readonly #partials = new Map<string, string>()
  readonly #finals = new Map<string, string>()
  readonly #order = new Map<string, number>()
  readonly #limit: number
  #nextSequence = 0
  #base = ""

  constructor(limit = 12_000) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  reset(base = ""): void {
    this.#partials.clear()
    this.#finals.clear()
    this.#order.clear()
    this.#nextSequence = 0
    this.#base = base.trim().slice(-this.#limit)
  }

  #track(itemId: string): void {
    if (!this.#order.has(itemId)) {
      this.#order.set(itemId, this.#nextSequence)
      this.#nextSequence += 1
    }
  }

  appendDelta(itemId: string, delta: string): string {
    this.#track(itemId)
    const partial = `${this.#partials.get(itemId) ?? ""}${delta}`
    this.#partials.set(itemId, partial)
    return partial
  }

  partial(itemId: string): string {
    return this.#partials.get(itemId) ?? ""
  }

  /** Everything currently being spoken, across items, in order. */
  livePartial(): string {
    return [...this.#partials.entries()]
      .sort(([a], [b]) => (this.#order.get(a) ?? 0) - (this.#order.get(b) ?? 0))
      .map(([, text]) => text)
      .join(" ")
      .trim()
  }

  complete(itemId: string, value: string): TranscriptCompletion {
    const text = value.trim()
    this.#track(itemId)
    this.#partials.delete(itemId)
    if (!text || this.#finals.get(itemId) === text) {
      return { accepted: false, transcript: this.combined() }
    }
    this.#finals.set(itemId, text)
    return { accepted: true, transcript: this.combined() }
  }

  combined(): string {
    const live = [...this.#finals.entries()]
      .sort(([a], [b]) => (this.#order.get(a) ?? 0) - (this.#order.get(b) ?? 0))
      .map(([, text]) => text)
      .join("\n")
    return `${this.#base}\n${live}`.trim().slice(-this.#limit)
  }

  /**
   * The recent tail, for a bounded excerpt.
   *
   * Handing a whole ambient transcript to a thread would be a privacy failure
   * dressed up as helpfulness, so the excerpt is always a window.
   */
  excerpt(characters = 1_200): string {
    return this.combined().slice(-Math.max(1, characters)).trim()
  }
}
