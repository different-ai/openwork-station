import type {
  AppEvent,
  CapabilityResponse,
  ConnectProviderStatus,
  ConnectRecord,
  ConnectReadScope,
  EnvironmentStatus,
  OpenWorkAppHost,
  UserGesture,
} from "./capabilities.js"

// Station's view of the host.
//
// A thin, typed wrapper over the one bridge object OpenWork exposes. It exists
// so the rest of Station never touches `window.openwork` directly, which keeps
// two things true:
//
//   * Every capability call has a name and a shape here. Adding a new one is a
//     visible change, not an ad-hoc string appearing somewhere in a component.
//   * The whole app is testable against a fake host, so behaviour under denial,
//     revocation, expiry, and workspace change is covered without a real
//     OpenWork running.

declare global {
  interface Window {
    openwork?: OpenWorkAppHost
  }
}

export class HostUnavailableError extends Error {
  constructor() {
    super("Station is running outside OpenWork, so the host bridge is not available.")
    this.name = "HostUnavailableError"
  }
}

export type CapabilityOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; permission?: string }

function toOutcome<T>(response: CapabilityResponse<T>): CapabilityOutcome<T> {
  if (response.ok) return { ok: true, value: response.result }
  return {
    ok: false,
    code: response.error.code,
    message: response.error.message,
    ...(response.error.permission === undefined ? {} : { permission: response.error.permission }),
  }
}

export class StationHost {
  readonly #bridge: OpenWorkAppHost
  /** At most one unspent gesture. Holding several would be a way to bank intent. */
  #gesture: UserGesture | null = null

  constructor(bridge: OpenWorkAppHost | undefined = globalThis.window?.openwork) {
    if (!bridge) throw new HostUnavailableError()
    this.#bridge = bridge
  }

  on(listener: (event: AppEvent) => void): () => void {
    return this.#bridge.on((event) => {
      // A shortcut carries a gesture the host minted on real input. Station
      // stores it rather than acting on it: the user still has to choose
      // something before it is spent.
      if (event.event === "shortcut" && event.gesture_token) {
        this.#gesture = { token: event.gesture_token, expiresAt: Date.now() + 10_000 }
      }
      listener(event)
    })
  }

  get hasGesture(): boolean {
    return this.#gesture !== null && this.#gesture.expiresAt > Date.now()
  }

  /** Take the gesture, if there is a live one. Single use by construction. */
  #takeGesture(): string | null {
    const gesture = this.#gesture
    this.#gesture = null
    if (!gesture || gesture.expiresAt <= Date.now()) return null
    return gesture.token
  }

  /** Record a gesture Station itself observed, such as a click on its own card. */
  noteLocalGesture(token: string, ttlMs = 10_000): void {
    this.#gesture = { token, expiresAt: Date.now() + ttlMs }
  }

  async environmentStatus(): Promise<CapabilityOutcome<{ variables: EnvironmentStatus[] }>> {
    return toOutcome(
      await this.#bridge.request<{ variables: EnvironmentStatus[] }>({ capability: "env.status" }),
    )
  }

  async realtimeSession(
    model: string,
    transcriptionModel?: string,
  ): Promise<CapabilityOutcome<{ client_secret: string; expires_at: number; model: string }>> {
    return toOutcome(
      await this.#bridge.request({
        capability: "ai.realtime.session",
        model,
        ...(transcriptionModel === undefined ? {} : { transcription_model: transcriptionModel }),
      }),
    )
  }

  async infer(
    task: string,
    input: string,
    responseSchema: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CapabilityOutcome<{ output: unknown; truncated: boolean }>> {
    return toOutcome(
      await this.#bridge.request({
        capability: "ai.inference.run",
        task,
        input,
        response_schema: responseSchema,
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      }),
    )
  }

  async connectCapabilities(): Promise<CapabilityOutcome<{ providers: ConnectProviderStatus[] }>> {
    return toOutcome(await this.#bridge.request({ capability: "connect.capabilities" }))
  }

  async connectQuery(
    scope: ConnectReadScope,
    query: string,
    limit = 8,
  ): Promise<CapabilityOutcome<{ records: ConnectRecord[]; truncated: boolean }>> {
    return toOutcome(
      await this.#bridge.request({ capability: "connect.query", scope, query, limit }),
    )
  }

  /**
   * Start a thread.
   *
   * Fails locally when there is no live gesture rather than sending a request
   * the host would refuse: the user should see "confirm this" immediately, not
   * after a round trip.
   */
  async startThread(payload: {
    title: string
    goal: string
    summary: string
    provenance: Array<{ scope: ConnectReadScope; title: string; url?: string; occurred_at?: string }>
    appSessionId: string
    attachmentId?: string
  }): Promise<CapabilityOutcome<{ thread_id: string }>> {
    const token = this.#takeGesture()
    if (!token) {
      return {
        ok: false,
        code: "gesture_required",
        message: "Confirm this to start a thread.",
      }
    }
    return toOutcome(
      await this.#bridge.request({
        capability: "threads.start",
        gesture_token: token,
        title: payload.title,
        goal: payload.goal,
        summary: payload.summary,
        provenance: payload.provenance,
        app_session_id: payload.appSessionId,
        ...(payload.attachmentId === undefined ? {} : { attachment_id: payload.attachmentId }),
      }),
    )
  }

  async createAttachment(
    filename: string,
    content: string,
  ): Promise<CapabilityOutcome<{ attachment_id: string }>> {
    const token = this.#takeGesture()
    if (!token) {
      return { ok: false, code: "gesture_required", message: "Confirm this to attach the excerpt." }
    }
    return toOutcome(
      await this.#bridge.request({
        capability: "attachments.create",
        gesture_token: token,
        filename,
        content_type: "text/markdown",
        content,
      }),
    )
  }

  async setStatus(
    status: string,
    value:
      | { kind: "clear" }
      | { kind: "dot"; tone: "neutral" | "active" | "attention" }
      | { kind: "badge"; count: number }
      | { kind: "text"; text: string },
  ): Promise<CapabilityOutcome<Record<string, never>>> {
    return toOutcome(await this.#bridge.request({ capability: "status.set", status, value }))
  }

  async startCapture(surface: string): Promise<CapabilityOutcome<Record<string, never>>> {
    return toOutcome(await this.#bridge.request({ capability: "audio.capture.start", surface }))
  }

  async stopCapture(): Promise<CapabilityOutcome<Record<string, never>>> {
    return toOutcome(await this.#bridge.request({ capability: "audio.capture.stop" }))
  }

  async storageGet<T>(key: string): Promise<T | null> {
    const outcome = toOutcome(
      await this.#bridge.request<{ value: unknown; present: boolean }>({
        capability: "storage.get",
        key,
      }),
    )
    if (!outcome.ok || !outcome.value.present) return null
    return outcome.value.value as T
  }

  async storageSet(key: string, value: unknown): Promise<boolean> {
    const outcome = toOutcome(
      await this.#bridge.request({ capability: "storage.set", key, value }),
    )
    return outcome.ok
  }
}
