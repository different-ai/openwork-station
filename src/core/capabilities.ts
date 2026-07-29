// The slice of the OpenWork App capability protocol Station uses.
//
// Declared here rather than imported so Station stays a genuine third-party
// consumer: it depends on the published protocol, not on OpenWork's internals.
// These shapes mirror `@openwork/app-contract` v1. Once that package is
// published, `tests/` should additionally assert conformance against it; until
// then the manifest test below is the structural check.

export type ConnectReadScope =
  | "slack.search"
  | "slack.channel.history"
  | "gmail.search"
  | "gmail.message.read"
  | "calendar.events.read"

export type CapabilityErrorCode =
  | "permission_denied"
  | "permission_revoked"
  | "gesture_required"
  | "gesture_expired"
  | "gesture_replayed"
  | "unsupported_capability"
  | "invalid_request"
  | "not_ready"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "workspace_changed"
  | "upstream_unavailable"
  | "network_host_denied"
  | "internal_error"

export type CapabilityError = {
  code: CapabilityErrorCode
  message: string
  permission?: string
}

export type CapabilityResponse<T> = { ok: true; result: T } | { ok: false; error: CapabilityError }

export type ConnectRecord = {
  scope: ConnectReadScope
  id: string
  title: string
  excerpt: string
  url?: string
  occurred_at?: string
  author?: string
}

export type ConnectProviderStatus = {
  provider: string
  scope: ConnectReadScope
  status: "available" | "not_connected" | "not_authorized" | "unavailable"
}

export type EnvironmentStatus = { key: string; configured: boolean; required: boolean }

/**
 * The host object exposed to a surface by the preload bridge.
 *
 * Every method is a broker call. There is no synchronous accessor, no raw IPC,
 * and nothing that returns a secret value — `env.status` reports only whether a
 * key is configured.
 */
export type OpenWorkAppHost = {
  request<T = unknown>(request: { capability: string; [key: string]: unknown }): Promise<CapabilityResponse<T>>
  on(listener: (event: AppEvent) => void): () => void
}

export type AppEvent =
  | { event: "lifecycle"; phase: "activate" | "deactivate" | "suspend" | "resume" }
  | { event: "command"; command: string }
  | { event: "shortcut"; shortcut: string; gesture_token?: string }
  | { event: "setting_changed"; setting: string; value: string | boolean }
  | { event: "surface_visibility"; surface: string; visible: boolean }
  | { event: "permission_revoked"; permission: string }
  | { event: "workspace_changed"; workspace_id: string | null }
  | { event: "environment_changed"; variables: EnvironmentStatus[] }

/**
 * A user gesture, as issued by the host and spent by Station.
 *
 * Tokens are short-lived and single-use. Station holds at most one, and drops
 * it the moment it is spent or expires, so a stale token can never be replayed
 * into an unintended thread.
 */
export type UserGesture = { token: string; expiresAt: number }

export function gestureIsUsable(gesture: UserGesture | null, now: number): boolean {
  return gesture !== null && gesture.expiresAt > now
}
