import { describe, expect, test } from "bun:test"

import { gestureIsUsable } from "../src/core/capabilities.js"
import { GOAL_TTL_MS, expireGoal, goalIsLive, spokenGoalDecision } from "../src/core/goal.js"
import { buildHandoff, MAX_EXCERPT_CHARACTERS } from "../src/core/handoff.js"
import { dismissSuggestion, selectAdjacent } from "../src/core/history.js"
import { effectiveRelevance, rankSuggestions } from "../src/core/relevance.js"
import { DEFAULT_SCOUT_POLICY, OpportunityScout, opportunityKey } from "../src/core/scout.js"
import { TranscriptAccumulator } from "../src/core/transcript.js"
import type { RankedSuggestion, StationGoal, StationSuggestion } from "../src/core/types.js"

const NOW = 1_700_000_000_000

function suggestion(overrides: Partial<StationSuggestion> = {}): StationSuggestion {
  return {
    id: "s1",
    kind: "context",
    title: "Berlin trip conflicts with the design review",
    summary: "Two events overlap on Thursday afternoon.",
    reason: "You just said you would be in Berlin on Thursday.",
    relevance: 0.9,
    sources: [],
    createdAt: NOW,
    ...overrides,
  }
}

function ranked(overrides: Partial<StationSuggestion> = {}): RankedSuggestion {
  return { ...suggestion(overrides), effectiveRelevance: 0.9 }
}

describe("relevance", () => {
  test("a suggestion decays with age", () => {
    const fresh = effectiveRelevance(suggestion(), "", NOW)
    const old = effectiveRelevance(suggestion(), "", NOW + 4 * 60_000)
    expect(old).toBeLessThan(fresh)
    expect(old).toBeCloseTo(fresh / 2, 2)
  })

  test("echoing the live transcript lifts a suggestion", () => {
    const plain = effectiveRelevance(suggestion({ relevance: 0.5 }), "", NOW)
    const echoed = effectiveRelevance(
      suggestion({ relevance: 0.5 }),
      "we should talk about the berlin design review thursday",
      NOW,
    )
    expect(echoed).toBeGreaterThan(plain)
  })

  test("a corrected suggestion replaces its predecessor by source identity", () => {
    const source = [{ scope: "calendar.events.read" as const, title: "Design review", url: "https://cal/1" }]
    const first = suggestion({ id: "a", title: "Thursday looks busy", sources: source, createdAt: NOW })
    const corrected = suggestion({
      id: "b",
      title: "Thursday conflicts with Berlin",
      sources: source,
      createdAt: NOW + 1_000,
    })
    const result = rankSuggestions([first], [corrected], "", NOW + 1_000)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("b")
  })

  test("suggestions without sources stay distinct when their titles differ", () => {
    const result = rankSuggestions(
      [suggestion({ id: "a", title: "First thing" })],
      [suggestion({ id: "b", title: "Second thing" })],
      "",
      NOW,
    )
    expect(result).toHaveLength(2)
  })

  test("fully decayed suggestions drop out entirely", () => {
    const ancient = suggestion({ createdAt: NOW - 60 * 60_000 })
    expect(rankSuggestions([ancient], [], "", NOW)).toHaveLength(0)
  })

  test("the list is capped and ordered by effective relevance", () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      suggestion({ id: `s${index}`, title: `Thing ${index}`, relevance: index / 20 }),
    )
    const result = rankSuggestions([], many, "", NOW)
    expect(result.length).toBeLessThanOrEqual(8)
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index - 1]!.effectiveRelevance).toBeGreaterThanOrEqual(
        result[index]!.effectiveRelevance,
      )
    }
  })
})

describe("history navigation", () => {
  const list = [ranked({ id: "a" }), ranked({ id: "b" }), ranked({ id: "c" })]

  test("dismissing selects the next card and does not return to passive", () => {
    const result = dismissSuggestion(list, "a", "a")
    expect(result.selectedId).toBe("b")
    expect(result.returnToPassive).toBe(false)
  })

  test("dismissing the last card returns to passive", () => {
    const result = dismissSuggestion([ranked({ id: "a" })], "a", "a")
    expect(result.suggestions).toHaveLength(0)
    expect(result.selectedId).toBeNull()
    expect(result.returnToPassive).toBe(true)
  })

  test("arrow navigation clamps instead of wrapping", () => {
    expect(selectAdjacent(list, "a", "newer")).toBe("a")
    expect(selectAdjacent(list, "c", "older")).toBe("c")
    expect(selectAdjacent(list, "a", "older")).toBe("b")
    expect(selectAdjacent(list, "b", "newer")).toBe("a")
  })

  test("navigating an empty history yields nothing rather than throwing", () => {
    expect(selectAdjacent([], null, "older")).toBeNull()
  })
})

describe("goal proposal", () => {
  function goal(overrides: Partial<StationGoal> = {}): StationGoal {
    return {
      id: "g1",
      title: "Check the Berlin conflict",
      statement: "I'll check whether Thursday is already booked.",
      reason: "You mentioned Berlin on Thursday.",
      focus: "calendar",
      status: "proposed",
      createdAt: NOW,
      expiresAt: NOW + GOAL_TTL_MS,
      ...overrides,
    }
  }

  test("short affirmatives accept and short negatives decline", () => {
    expect(spokenGoalDecision("yes")).toBe("accept")
    expect(spokenGoalDecision("go ahead")).toBe("accept")
    expect(spokenGoalDecision("no")).toBe("decline")
    expect(spokenGoalDecision("not now")).toBe("decline")
    expect(spokenGoalDecision("never mind")).toBe("decline")
  })

  test("a long sentence starting with no is not treated as an answer", () => {
    expect(
      spokenGoalDecision(
        "no I was saying to Marcus that the deployment should wait until after the review meeting on Thursday",
      ),
    ).toBeNull()
  })

  test("unrelated speech is not an answer", () => {
    expect(spokenGoalDecision("so anyway the build is green")).toBeNull()
    expect(spokenGoalDecision("")).toBeNull()
  })

  test("an unanswered proposal expires rather than lingering", () => {
    expect(goalIsLive(goal(), NOW + 1_000)).toBe(true)
    expect(goalIsLive(goal(), NOW + GOAL_TTL_MS + 1)).toBe(false)
    expect(expireGoal(goal(), NOW + GOAL_TTL_MS + 1)).toBeNull()
  })

  test("an accepted goal is not expired by the proposal timeout", () => {
    const accepted = goal({ status: "accepted" })
    expect(expireGoal(accepted, NOW + GOAL_TTL_MS + 1)).toBe(accepted)
  })
})

describe("transcript reconciliation", () => {
  test("interleaved items stay in first-appearance order", () => {
    const accumulator = new TranscriptAccumulator()
    accumulator.appendDelta("item-1", "we should")
    accumulator.appendDelta("item-2", "and also")
    accumulator.complete("item-2", "and also check the calendar")
    accumulator.complete("item-1", "we should talk to Marcus")
    expect(accumulator.combined()).toBe("we should talk to Marcus\nand also check the calendar")
  })

  test("a repeated final is ignored", () => {
    const accumulator = new TranscriptAccumulator()
    expect(accumulator.complete("i", "hello there").accepted).toBe(true)
    expect(accumulator.complete("i", "hello there").accepted).toBe(false)
    expect(accumulator.combined()).toBe("hello there")
  })

  test("an empty final is ignored", () => {
    const accumulator = new TranscriptAccumulator()
    expect(accumulator.complete("i", "   ").accepted).toBe(false)
  })

  test("a final clears its partial", () => {
    const accumulator = new TranscriptAccumulator()
    accumulator.appendDelta("i", "hel")
    expect(accumulator.partial("i")).toBe("hel")
    accumulator.complete("i", "hello")
    expect(accumulator.partial("i")).toBe("")
    expect(accumulator.livePartial()).toBe("")
  })

  test("the transcript is bounded", () => {
    const accumulator = new TranscriptAccumulator(100)
    for (let index = 0; index < 50; index += 1) {
      accumulator.complete(`i${index}`, `sentence number ${index}`)
    }
    expect(accumulator.combined().length).toBeLessThanOrEqual(100)
  })

  test("reset drops everything from the previous session", () => {
    const accumulator = new TranscriptAccumulator()
    accumulator.complete("i", "private thing")
    accumulator.reset()
    expect(accumulator.combined()).toBe("")
  })

  test("the excerpt is a bounded tail", () => {
    const accumulator = new TranscriptAccumulator()
    accumulator.complete("i", "x".repeat(5_000))
    expect(accumulator.excerpt(100).length).toBe(100)
  })
})

describe("opportunity scout", () => {
  const context = (length: number) => "a".repeat(length)

  test("nothing runs before a session starts", () => {
    const scout = new OpportunityScout()
    expect(scout.shouldDetect(context(1_000), NOW)).toEqual({
      run: false,
      reason: "not_listening",
    })
  })

  test("the first pass runs as soon as there is enough new context", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    const decision = scout.shouldDetect(context(200), NOW)
    expect(decision.run).toBe(true)
  })

  test("detection does not wait for the user to stop speaking", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    // An unfinished partial — no terminal punctuation, mid-clause. The only gate
    // is how much new context there is, never whether the turn ended.
    const partial =
      "I need to prepare for the Berlin design review on Thursday and I still have not heard back from"
    expect(partial.endsWith(".")).toBe(false)
    expect(scout.shouldDetect(partial, NOW).run).toBe(true)
  })

  test("the only gate on a partial is how much new context it carries", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    const tooShort = "a".repeat(DEFAULT_SCOUT_POLICY.minNewCharacters - 1)
    expect(scout.shouldDetect(tooShort, NOW)).toEqual({
      run: false,
      reason: "insufficient_new_context",
    })
    expect(scout.shouldDetect("a".repeat(DEFAULT_SCOUT_POLICY.minNewCharacters), NOW).run).toBe(true)
  })

  test("a second pass is refused until the interval elapses", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    scout.beginDetection("d1", context(200), NOW)
    scout.endDetection("d1")
    expect(scout.shouldDetect(context(400), NOW + 1_000)).toEqual({ run: false, reason: "too_soon" })
    expect(scout.shouldDetect(context(400), NOW + DEFAULT_SCOUT_POLICY.minIntervalMs).run).toBe(true)
  })

  test("a pass is refused without enough new context", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    scout.beginDetection("d1", context(200), NOW)
    scout.endDetection("d1")
    const later = NOW + DEFAULT_SCOUT_POLICY.minIntervalMs
    expect(scout.shouldDetect(context(210), later)).toEqual({
      run: false,
      reason: "insufficient_new_context",
    })
  })

  test("only one detection runs at a time", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    scout.beginDetection("d1", context(200), NOW)
    const later = NOW + DEFAULT_SCOUT_POLICY.minIntervalMs
    expect(scout.shouldDetect(context(600), later)).toEqual({
      run: false,
      reason: "detection_in_flight",
    })
  })

  test("a lost reply cannot wedge the deciding phase forever", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    scout.beginDetection("d1", context(200), NOW)
    expect(scout.detectionsInFlight).toBe(1)
    const reaped = scout.reapTimedOut(NOW + DEFAULT_SCOUT_POLICY.decisionTimeoutMs)
    expect(reaped.detections).toEqual(["d1"])
    expect(scout.detectionsInFlight).toBe(0)
  })

  test("the per-minute ceiling stops runaway inference", () => {
    const scout = new OpportunityScout({ minIntervalMs: 0, minNewCharacters: 1 })
    scout.startSession(NOW)
    for (let index = 0; index < DEFAULT_SCOUT_POLICY.maxDetectionsPerMinute; index += 1) {
      const at = NOW + index
      expect(scout.shouldDetect(context(100 + index * 10), at).run).toBe(true)
      scout.beginDetection(`d${index}`, context(100 + index * 10), at)
      scout.endDetection(`d${index}`)
    }
    expect(scout.shouldDetect(context(9_000), NOW + 100)).toEqual({
      run: false,
      reason: "rate_limited",
    })
    // The window rolls, so the ceiling throttles rather than latching off.
    expect(scout.shouldDetect(context(9_000), NOW + 61_000).run).toBe(true)
  })

  test("research does not start until the goal is accepted", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    expect(scout.shouldResearch(false, NOW)).toEqual({ run: false, reason: "goal_not_accepted" })
    expect(scout.shouldResearch(true, NOW).run).toBe(true)
  })

  test("connected-source queries are rate limited", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    for (let index = 0; index < DEFAULT_SCOUT_POLICY.maxConnectQueriesPerMinute; index += 1) {
      scout.noteConnectQuery(NOW + index)
    }
    expect(scout.shouldResearch(true, NOW + 100)).toEqual({
      run: false,
      reason: "connect_rate_limited",
    })
  })

  test("stopping invalidates work already in flight", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    const epoch = scout.beginDetection("d1", context(200), NOW)
    expect(scout.isCurrent(epoch)).toBe(true)
    scout.endSession()
    expect(scout.isCurrent(epoch)).toBe(false)
    expect(scout.detectionsInFlight).toBe(0)
  })

  test("a workspace change invalidates work bound to the old context", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    const epoch = scout.beginResearch("r1", NOW)
    scout.invalidateContext()
    expect(scout.isCurrent(epoch)).toBe(false)
    expect(scout.researchInFlight).toBe(0)
  })

  test("a new session does not inherit the previous session's budget", () => {
    const scout = new OpportunityScout({ minIntervalMs: 0, minNewCharacters: 1 })
    scout.startSession(NOW)
    for (let index = 0; index < DEFAULT_SCOUT_POLICY.maxDetectionsPerMinute; index += 1) {
      scout.beginDetection(`d${index}`, context(100 + index * 10), NOW + index)
      scout.endDetection(`d${index}`)
    }
    expect(scout.shouldDetect(context(9_000), NOW + 100).run).toBe(false)
    scout.startSession(NOW + 200)
    expect(scout.shouldDetect(context(9_000), NOW + 200).run).toBe(true)
  })

  test("duplicates are suppressed within the window and allowed after it", () => {
    const scout = new OpportunityScout()
    scout.startSession(NOW)
    const key = opportunityKey({ focus: "calendar", subject: "Berlin design review Thursday" })
    expect(scout.isDuplicate(key, NOW)).toBe(false)
    scout.noteOpportunity(key, NOW)
    expect(scout.isDuplicate(key, NOW + 1_000)).toBe(true)
    expect(scout.isDuplicate(key, NOW + DEFAULT_SCOUT_POLICY.duplicateWindowMs + 1)).toBe(false)
  })

  test("word order, case, and punctuation do not change the key", () => {
    expect(opportunityKey({ focus: "calendar", subject: "Berlin design review Thursday" })).toBe(
      opportunityKey({ focus: "calendar", subject: "thursday, review — design (Berlin)" }),
    )
  })

  test("short filler words are ignored", () => {
    expect(opportunityKey({ focus: "calendar", subject: "the Berlin review" })).toBe(
      opportunityKey({ focus: "calendar", subject: "a Berlin review, on the" }),
    )
  })

  test("a different focus does not collide with the same subject", () => {
    expect(opportunityKey({ focus: "calendar", subject: "Berlin review" })).not.toBe(
      opportunityKey({ focus: "person", subject: "Berlin review" }),
    )
  })

  test("a materially different subject does not collide", () => {
    // The key is coarse but not lossy: an extra significant word is a different
    // opportunity, which is the safe direction to err in — a missed suppression
    // shows one extra card, an over-eager one silently hides a real suggestion.
    expect(opportunityKey({ focus: "calendar", subject: "Berlin review" })).not.toBe(
      opportunityKey({ focus: "calendar", subject: "Berlin review budget" }),
    )
  })
})

describe("gestures", () => {
  test("a gesture is usable until it expires", () => {
    expect(gestureIsUsable({ token: "t", expiresAt: NOW + 1 }, NOW)).toBe(true)
    expect(gestureIsUsable({ token: "t", expiresAt: NOW }, NOW)).toBe(false)
    expect(gestureIsUsable(null, NOW)).toBe(false)
  })
})

describe("thread handoff", () => {
  const base = {
    suggestion: ranked({
      sources: [
        { scope: "calendar.events.read" as const, title: "Design review", url: "https://cal/1" },
      ],
    }),
    goal: null,
    sessionId: "sess-1",
    workspaceId: "ws-1",
    appVersion: "0.1.0",
    transcriptExcerpt: "we were saying the Berlin trip lands on Thursday",
    now: NOW,
  }

  test("the transcript is excluded unless the user chose to include it", () => {
    const handoff = buildHandoff({ ...base, includeTranscript: false })
    expect(handoff.attachment).toBeNull()
    expect(handoff.audit.transcriptIncluded).toBe(false)
  })

  test("an included excerpt is attached and recorded in the audit", () => {
    const handoff = buildHandoff({ ...base, includeTranscript: true })
    expect(handoff.attachment?.contentType).toBe("text/markdown")
    expect(handoff.attachment?.content).toContain("Berlin trip lands on Thursday")
    expect(handoff.audit.transcriptIncluded).toBe(true)
  })

  test("even an included excerpt is bounded, never the whole session", () => {
    const handoff = buildHandoff({
      ...base,
      includeTranscript: true,
      transcriptExcerpt: "x".repeat(50_000),
    })
    expect(handoff.attachment?.content.length).toBeLessThan(MAX_EXCERPT_CHARACTERS + 200)
  })

  test("provenance carries the sources the card cited", () => {
    const handoff = buildHandoff({ ...base, includeTranscript: false })
    expect(handoff.provenance).toEqual([
      { scope: "calendar.events.read", title: "Design review", url: "https://cal/1" },
    ])
    expect(handoff.audit.sourceCount).toBe(1)
  })

  test("a card with no sources says so instead of implying research happened", () => {
    const handoff = buildHandoff({
      ...base,
      suggestion: ranked({ sources: [] }),
      includeTranscript: false,
    })
    expect(handoff.summary).toContain("no connected-source evidence")
    expect(handoff.provenance).toEqual([])
  })

  test("the audit record carries no transcript body", () => {
    const handoff = buildHandoff({ ...base, includeTranscript: true })
    expect(JSON.stringify(handoff.audit)).not.toContain("Berlin")
  })

  test("an accepted goal becomes the thread's goal", () => {
    const goal: StationGoal = {
      id: "g1",
      title: "Check the conflict",
      statement: "I'll check whether Thursday is already booked.",
      reason: "…",
      focus: "calendar",
      status: "accepted",
      createdAt: NOW,
      expiresAt: NOW + GOAL_TTL_MS,
    }
    expect(buildHandoff({ ...base, goal, includeTranscript: false }).goal).toBe(
      "I'll check whether Thursday is already booked.",
    )
  })
})
