import { GOAL_TTL_MS, expireGoal, spokenGoalDecision } from "../core/goal.js"
import { buildHandoff } from "../core/handoff.js"
import { StationHost } from "../core/host.js"
import { rankSuggestions } from "../core/relevance.js"
import { OpportunityScout, opportunityKey } from "../core/scout.js"
import { TranscriptAccumulator } from "../core/transcript.js"
import type {
  RankedSuggestion,
  StationGoal,
  StationPhase,
  StationState,
  StationSuggestion,
  StationUnavailableReason,
} from "../core/types.js"
import { INITIAL_STATION_STATE } from "../core/types.js"
import { DETECTION_SCHEMA, RESEARCH_SCHEMA, detectionPrompt, researchPrompt } from "./prompts.js"

// The Station background runtime.
//
// Drives the loop: transcribe, notice, propose, research, present. It holds the
// state; the surface renders it and sends intent back.
//
// The thing this file is careful about is not doing too much. Every expensive
// step is gated by the scout, which decides whether the moment is worth
// spending inference on, whether a goal was accepted, and whether a result is
// still current. Without that, continuous speech becomes continuous spend and
// the app gets slower exactly when the conversation gets interesting.

const REALTIME_MODEL = "gpt-realtime"
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe"
const SURFACE_ID = "station"
const STORAGE_DISMISSED = "dismissed"

type SurfaceMessage =
  | { type: "surface-ready" }
  | { type: "toggle-listening" }
  | { type: "dismiss"; id: string }
  | { type: "select"; id: string | null }
  | { type: "start-thread"; id: string }
  | { type: "accept-goal" }
  | { type: "decline-goal" }
  | { type: "clear-transcript" }
  | { type: "blur" }

export class StationAgent {
  readonly #host: StationHost
  readonly #scout = new OpportunityScout()
  readonly #transcript = new TranscriptAccumulator()
  readonly #sessionId = `station-${Math.floor(Date.now() / 1000).toString(36)}`
  #state: StationState = { ...INITIAL_STATION_STATE }
  #dismissed = new Set<string>()
  #publish: (state: StationState) => void = () => {}
  #tick: ReturnType<typeof setInterval> | null = null

  constructor(host: StationHost) {
    this.#host = host
  }

  get state(): StationState {
    return this.#state
  }

  onPublish(publish: (state: StationState) => void): void {
    this.#publish = publish
  }

  async activate(): Promise<void> {
    const remembered = await this.#host.storageGet<string[]>(STORAGE_DISMISSED)
    if (Array.isArray(remembered)) this.#dismissed = new Set(remembered)

    this.#host.on((event) => {
      switch (event.event) {
        case "shortcut":
          void this.toggleListening()
          break
        case "setting_changed":
          if (event.setting === "show-transcript") {
            // Showing the transcript is a display preference. Turning it off
            // must not turn Station off, which is a bug users hit constantly in
            // apps that conflate the two.
            this.#patch({ transcriptVisible: event.value === true })
          }
          break
        case "permission_revoked":
          void this.stopListening(`Station lost permission: ${event.permission}.`)
          break
        case "workspace_changed":
          // Everything in flight belonged to the previous context.
          this.#scout.invalidateContext()
          this.#patch({ suggestions: [], selectedId: null, goal: null })
          break
        case "lifecycle":
          if (event.phase === "deactivate") void this.stopListening(null)
          break
        default:
          break
      }
    })
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  async toggleListening(): Promise<void> {
    if (this.#state.listening) {
      await this.stopListening(null)
      return
    }
    await this.startListening()
  }

  async startListening(): Promise<void> {
    this.#patch({ phase: "connecting", error: null, unavailable: null })

    const session = await this.#host.realtimeSession(REALTIME_MODEL, TRANSCRIPTION_MODEL)
    if (!session.ok) {
      this.#patch({
        phase: session.code === "permission_denied" ? "disabled" : "error",
        listening: false,
        error: session.message,
      })
      return
    }

    const capture = await this.#host.startCapture(SURFACE_ID)
    if (!capture.ok) {
      this.#patch({ phase: "error", listening: false, error: capture.message })
      return
    }

    this.#transcript.reset()
    this.#scout.startSession(Date.now())
    this.#patch({ listening: true, phase: "listening", transcript: "", partialTranscript: "" })
    await this.#host.setStatus("station-status", { kind: "dot", tone: "active" })

    // A single timer drives detection. Reaping happens on the same tick, so a
    // reply that never arrives cannot leave the UI on "Thinking".
    this.#tick = setInterval(() => void this.#pump(), 1_000)
  }

  async stopListening(reason: string | null): Promise<void> {
    if (this.#tick !== null) {
      clearInterval(this.#tick)
      this.#tick = null
    }
    this.#scout.endSession()
    await this.#host.stopCapture()
    await this.#host.setStatus("station-status", { kind: "clear" })
    this.#transcript.reset()
    this.#patch({
      listening: false,
      phase: "idle",
      transcript: "",
      partialTranscript: "",
      goal: null,
      error: reason,
    })
  }

  // -------------------------------------------------------------------------
  // Transcription input
  // -------------------------------------------------------------------------

  /** A partial from the realtime model. Cheap, frequent, and useful immediately. */
  onTranscriptDelta(itemId: string, delta: string): void {
    this.#transcript.appendDelta(itemId, delta)
    this.#patch({ partialTranscript: this.#transcript.livePartial() })
  }

  /** A finalised segment. */
  onTranscriptFinal(itemId: string, text: string): void {
    const completion = this.#transcript.complete(itemId, text)
    if (!completion.accepted) return
    this.#patch({
      transcript: completion.transcript,
      partialTranscript: this.#transcript.livePartial(),
    })

    // A short spoken yes/no answers a pending proposal. Long sentences that
    // merely start with "no" are somebody talking to someone else.
    const goal = this.#state.goal
    if (goal && goal.status === "proposed") {
      const decision = spokenGoalDecision(text)
      if (decision === "accept") void this.acceptGoal()
      if (decision === "decline") this.declineGoal()
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  async #pump(): Promise<void> {
    const now = Date.now()

    const reaped = this.#scout.reapTimedOut(now)
    if (reaped.detections.length > 0 && this.#state.phase === "deciding") {
      // Never sit on "deciding". Say nothing came of it and go back to
      // listening, which is honest and lets the next moment be considered.
      this.#patch({ phase: "listening" })
    }

    const expired = expireGoal(this.#state.goal, now)
    if (expired !== this.#state.goal) this.#patch({ goal: expired })

    const context = `${this.#transcript.combined()} ${this.#transcript.livePartial()}`.trim()
    const decision = this.#scout.shouldDetect(context, now)
    if (!decision.run) return

    const id = `detect-${now}`
    const epoch = this.#scout.beginDetection(id, context, now)
    this.#patch({ phase: "deciding" })

    try {
      const result = await this.#host.infer(
        "opportunity-detection",
        detectionPrompt(context),
        DETECTION_SCHEMA,
        10_000,
      )
      if (!this.#scout.isCurrent(epoch)) return
      if (!result.ok) {
        this.#patch({ phase: "listening" })
        return
      }
      await this.#onDetection(result.value.output, now)
    } finally {
      this.#scout.endDetection(id)
      if (this.#state.phase === "deciding") this.#patch({ phase: "listening" })
    }
  }

  async #onDetection(output: unknown, now: number): Promise<void> {
    const detection = readDetection(output)
    if (!detection || !detection.worthwhile) {
      this.#patch({
        phase: "listening",
        unavailable: this.#state.suggestions.length === 0 ? "no_useful_context" : null,
      })
      return
    }

    const key = opportunityKey({ focus: detection.focus, subject: detection.subject })
    if (this.#scout.isDuplicate(key, now) || this.#dismissed.has(key)) return
    this.#scout.noteOpportunity(key, now)

    // Propose before researching. The user can say no, and saying no is as
    // cheap as saying yes.
    const goal: StationGoal = {
      id: key,
      title: detection.subject,
      statement: detection.statement,
      reason: detection.reason,
      focus: detection.focus,
      status: "proposed",
      createdAt: now,
      expiresAt: now + GOAL_TTL_MS,
    }
    this.#patch({ goal, phase: "listening" })
    await this.#host.setStatus("station-status", { kind: "dot", tone: "attention" })
  }

  async acceptGoal(): Promise<void> {
    const goal = this.#state.goal
    if (!goal || goal.status !== "proposed") return
    const now = Date.now()
    const decision = this.#scout.shouldResearch(true, now)
    if (!decision.run) {
      this.#patch({ goal: { ...goal, status: "declined" }, unavailable: "budget_exhausted" })
      return
    }

    this.#patch({ goal: { ...goal, status: "researching" }, phase: "researching" })
    const id = `research-${now}`
    const epoch = this.#scout.beginResearch(id, now)

    try {
      const suggestion = await this.#research(goal, now)
      if (!this.#scout.isCurrent(epoch)) return
      if (!suggestion) {
        this.#patch({ phase: "unavailable", goal: null })
        return
      }
      const ranked = rankSuggestions(
        this.#state.suggestions,
        [suggestion],
        this.#state.transcript,
        Date.now(),
      )
      this.#patch({
        suggestions: ranked,
        selectedId: ranked[0]?.id ?? null,
        goal: null,
        phase: "ready",
        unavailable: null,
      })
      await this.#host.setStatus("station-status", { kind: "badge", count: ranked.length })
    } finally {
      this.#scout.endResearch(id)
    }
  }

  declineGoal(): void {
    const goal = this.#state.goal
    if (!goal) return
    // A declined topic stays declined for this session, so the same suggestion
    // does not come back a minute later.
    this.#dismissed.add(goal.id)
    void this.#host.storageSet(STORAGE_DISMISSED, [...this.#dismissed])
    this.#patch({ goal: null, phase: "listening" })
  }

  async #research(goal: StationGoal, now: number): Promise<StationSuggestion | null> {
    const capabilities = await this.#host.connectCapabilities()
    const available = capabilities.ok
      ? capabilities.value.providers.filter((entry) => entry.status === "available")
      : []

    if (available.length === 0) {
      // Say which kind of nothing this is. "No sources connected" is a
      // different problem from "nothing relevant found".
      this.#patch({ unavailable: capabilities.ok ? "no_connections" : "connection_failed" })
      return null
    }

    const records: Array<{ scope: (typeof available)[number]["scope"]; title: string; excerpt: string; url?: string; occurredAt?: string }> = []
    for (const provider of available) {
      this.#scout.noteConnectQuery(Date.now())
      const result = await this.#host.connectQuery(provider.scope, goal.title, 5)
      if (!result.ok) continue
      for (const entry of result.value.records) {
        records.push({
          scope: entry.scope,
          title: entry.title,
          excerpt: entry.excerpt,
          ...(entry.url === undefined ? {} : { url: entry.url }),
          ...(entry.occurred_at === undefined ? {} : { occurredAt: entry.occurred_at }),
        })
      }
    }

    if (records.length === 0) {
      this.#patch({ unavailable: "no_useful_context" })
      return null
    }

    const drafted = await this.#host.infer(
      "research-synthesis",
      researchPrompt(goal, records),
      RESEARCH_SCHEMA,
      20_000,
    )
    if (!drafted.ok) return null
    const card = readResearch(drafted.value.output)
    if (!card) return null

    return {
      id: `${goal.id}-${now}`,
      kind: card.kind,
      title: card.title,
      summary: card.summary,
      reason: card.reason,
      relevance: card.confidence,
      // Only sources the model actually cited, matched back to real records, so
      // a card can never claim evidence that was not retrieved.
      sources: card.citedTitles
        .map((title) => records.find((record) => record.title === title))
        .filter((record): record is NonNullable<typeof record> => record !== undefined)
        .map((record) => ({
          scope: record.scope,
          title: record.title,
          ...(record.url === undefined ? {} : { url: record.url }),
          ...(record.occurredAt === undefined ? {} : { occurredAt: record.occurredAt }),
        })),
      createdAt: now,
    }
  }

  // -------------------------------------------------------------------------
  // Surface intent
  // -------------------------------------------------------------------------

  async handleSurfaceMessage(message: SurfaceMessage): Promise<void> {
    switch (message.type) {
      case "surface-ready":
        this.#publish(this.#state)
        break
      case "toggle-listening":
        await this.toggleListening()
        break
      case "dismiss": {
        const dismissed = this.#state.suggestions.find((entry) => entry.id === message.id)
        if (dismissed) {
          this.#dismissed.add(dismissed.id)
          void this.#host.storageSet(STORAGE_DISMISSED, [...this.#dismissed])
        }
        const remaining = this.#state.suggestions.filter((entry) => entry.id !== message.id)
        this.#patch({
          suggestions: remaining,
          selectedId: remaining[0]?.id ?? null,
          phase: remaining.length === 0 ? "listening" : this.#state.phase,
        })
        await this.#host.setStatus(
          "station-status",
          remaining.length === 0 ? { kind: "clear" } : { kind: "badge", count: remaining.length },
        )
        break
      }
      case "select":
        this.#patch({ selectedId: message.id })
        break
      case "accept-goal":
        await this.acceptGoal()
        break
      case "decline-goal":
        this.declineGoal()
        break
      case "clear-transcript":
        this.#transcript.reset()
        this.#patch({ transcript: "", partialTranscript: "" })
        break
      case "start-thread":
        await this.startThread(message.id)
        break
      case "blur":
        break
    }
  }

  async startThread(suggestionId: string, includeTranscript = false): Promise<string | null> {
    const suggestion = this.#state.suggestions.find((entry) => entry.id === suggestionId)
    if (!suggestion) return null

    const handoff = buildHandoff({
      suggestion: suggestion as RankedSuggestion,
      goal: this.#state.goal,
      sessionId: this.#sessionId,
      workspaceId: null,
      appVersion: "0.1.0",
      includeTranscript,
      transcriptExcerpt: this.#transcript.excerpt(),
      now: Date.now(),
    })

    let attachmentId: string | undefined
    if (handoff.attachment) {
      const created = await this.#host.createAttachment(
        handoff.attachment.filename,
        handoff.attachment.content,
      )
      if (created.ok) attachmentId = created.value.attachment_id
    }

    const started = await this.#host.startThread({
      title: handoff.title,
      goal: handoff.goal,
      summary: handoff.summary,
      provenance: handoff.provenance.map((entry) => ({
        scope: entry.scope as never,
        title: entry.title,
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.occurred_at === undefined ? {} : { occurred_at: entry.occurred_at }),
      })),
      appSessionId: handoff.appSessionId,
      ...(attachmentId === undefined ? {} : { attachmentId }),
    })

    if (!started.ok) {
      this.#patch({ error: started.message })
      return null
    }
    await this.handleSurfaceMessage({ type: "dismiss", id: suggestionId })
    return started.value.thread_id
  }

  #patch(partial: Partial<StationState>): void {
    this.#state = { ...this.#state, ...partial }
    this.#publish(this.#state)
  }
}

type Detection = {
  worthwhile: boolean
  focus: StationGoal["focus"]
  subject: string
  statement: string
  reason: string
}

function readDetection(output: unknown): Detection | null {
  if (typeof output !== "object" || output === null) return null
  const record = output as Record<string, unknown>
  const focus = record.focus
  const valid: StationGoal["focus"][] = [
    "prior_conversation",
    "person",
    "commitment",
    "calendar",
    "follow_up",
    "decision",
    "next_step",
  ]
  if (typeof focus !== "string" || !valid.includes(focus as StationGoal["focus"])) return null
  return {
    worthwhile: record.worthwhile === true,
    focus: focus as StationGoal["focus"],
    subject: typeof record.subject === "string" ? record.subject : "",
    statement: typeof record.statement === "string" ? record.statement : "",
    reason: typeof record.reason === "string" ? record.reason : "",
  }
}

type Research = {
  kind: StationSuggestion["kind"]
  title: string
  summary: string
  reason: string
  confidence: number
  citedTitles: string[]
}

function readResearch(output: unknown): Research | null {
  if (typeof output !== "object" || output === null) return null
  const record = output as Record<string, unknown>
  const kinds: StationSuggestion["kind"][] = ["context", "preparation", "commitment", "conflict"]
  const kind = typeof record.kind === "string" ? record.kind : ""
  if (!kinds.includes(kind as StationSuggestion["kind"])) return null
  const confidence = typeof record.confidence === "number" ? record.confidence : 0
  if (!(confidence > 0)) return null
  return {
    kind: kind as StationSuggestion["kind"],
    title: typeof record.title === "string" ? record.title : "",
    summary: typeof record.summary === "string" ? record.summary : "",
    reason: typeof record.reason === "string" ? record.reason : "",
    confidence: Math.min(1, confidence),
    citedTitles: Array.isArray(record.cited)
      ? record.cited.filter((entry): entry is string => typeof entry === "string")
      : [],
  }
}

export function activate(host = new StationHost()): StationAgent {
  const agent = new StationAgent(host)
  void agent.activate()
  return agent
}
