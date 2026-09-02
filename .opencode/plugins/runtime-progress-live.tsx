/** @jsxImportSource @opentui/solid */
import { randomUUID } from "node:crypto"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, createSignal } from "solid-js"

const PLUGIN_ID = "agentic-harness.runtime-progress-live"
const PROGRESS_SYSTEM_MARKER = "CLIP_RUNTIME_PROGRESS_LIVE_V1"
const PROGRESS_PREFIX = "▣ Runtime-Progress-Reporter"
const TERMINAL_PREFIX = "Agentic Harness Runtime V2 continuation event."

const DEFAULT_POLL_MS = 750
const DEFAULT_IDLE_POLL_MS = 3_000
const DEFAULT_MESSAGE_LIMIT = 80
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000
const DEFAULT_OBSERVATION_URL = `http://127.0.0.1:${String(process.env.CONTEXT_ENGINE_HTTP_PORT ?? "8789").trim() || "8789"}/runtime-progress-observation`
const DEFAULT_LIVE_SNAPSHOT_URL = `http://127.0.0.1:${String(process.env.CONTEXT_ENGINE_HTTP_PORT ?? "8789").trim() || "8789"}/runtime-progress-live`
const DEFAULT_LIVE_SNAPSHOT_POLL_MS = 1_000
const DURABLE_OBSERVATION_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const

type PluginOptions = {
  pollMs?: number
  idlePollMs?: number
  messageLimit?: number
  staleAfterMs?: number
  observationUrl?: string
  liveSnapshotUrl?: string
  liveSnapshotPollMs?: number
}

type SessionMessage = {
  info?: {
    id?: string
    role?: string
    system?: string
    time?: { created?: number }
  }
  parts?: Array<{ type?: string; text?: string }>
}

type LiveCheckpoint = {
  sessionID: string
  messageID: string
  runID: string | null
  text: string
  createdAt: number
}

type RuntimeProgressLiveSnapshot = {
  runId?: string
  generatedAt?: string
  run?: { status?: string; terminal?: boolean }
  progress?: { terminal?: number; total?: number; percent?: number }
  presentation?: {
    deliveryMode?: string | null
    checkpoint?: {
      messageId?: string | null
      text?: string | null
      sourceEventId?: string | null
      sourceEventType?: string | null
      effectKey?: string | null
      createdAt?: number | null
      deliveryMode?: string | null
    } | null
  } | null
  controlPlane?: {
    status?: "healthy" | "degraded"
    consecutiveFailures?: number
    lastRecoveredAt?: string | null
    activeFailure?: { message?: string; createdAt?: string | null } | null
  }
  current?: Array<{
    stage?: string | null
    shortTaskId?: string | null
    elapsedMs?: number | null
    liveness?: {
      heartbeatAt?: string | null
      heartbeatAgeMs?: number | null
      heartbeatFresh?: boolean
      heartbeatStaleAfterMs?: number | null
      executorElapsedMs?: number | null
      idleMs?: number | null
    } | null
  }>
}

type ProjectorObservationEvent =
  | "progress.live_projector_loaded"
  | "progress.live_projector_attached"
  | "progress.live_projector_heartbeat"
  | "progress.live_projector_detached"
  | "progress.live_delivery_observed"
  | "progress.live_projector_disposed"

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function messageText(message: SessionMessage) {
  return (message.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim()
}

function createdAt(message: SessionMessage) {
  const value = Number(message.info?.time?.created ?? 0)
  return Number.isFinite(value) ? value : 0
}

function runIdFromSystem(value: unknown) {
  const match = String(value ?? "").match(/CLIP_RUNTIME_PROGRESS_RUN_ID=([A-Za-z0-9._:-]+)/)
  const raw = match?.[1] ?? ""
  // Historical R11 checkpoints used a period as narrative punctuation directly
  // after the marker. The previous regex accepted that period as part of runId,
  // producing e.g. `run-<uuid>.` and preventing durable observation correlation.
  // Keep dotted ids compatible while stripping punctuation that terminates the
  // marker token. New checkpoints use an explicit semicolon delimiter.
  const normalized = raw.replace(/[.;,!?]+$/, "")
  return normalized || null
}

function latestProgress(messages: SessionMessage[], sessionID: string): LiveCheckpoint | null {
  const checkpoints = messages.flatMap((message) => {
    const system = String(message.info?.system ?? "")
    const text = messageText(message)
    const messageID = String(message.info?.id ?? "")
    if (message.info?.role !== "user") return []
    if (!system.includes(PROGRESS_SYSTEM_MARKER)) return []
    if (!text.startsWith(PROGRESS_PREFIX) || !messageID) return []
    return [{ sessionID, messageID, runID: runIdFromSystem(system), text, createdAt: createdAt(message) }]
  })
  checkpoints.sort((left, right) => right.createdAt - left.createdAt)
  return checkpoints[0] ?? null
}

function terminalContinuationAfter(messages: SessionMessage[], checkpoint: LiveCheckpoint) {
  return messages.some((message) => {
    if (message.info?.role !== "user") return false
    if (createdAt(message) < checkpoint.createdAt) return false
    return messageText(message).startsWith(TERMINAL_PREFIX)
  })
}

function checkpointFromSnapshot(snapshot: RuntimeProgressLiveSnapshot | null, sessionID: string): LiveCheckpoint | null {
  if (!snapshot?.runId || snapshot.run?.terminal === true) return null
  const checkpoint = snapshot.presentation?.checkpoint
  const messageID = String(checkpoint?.messageId ?? "").trim()
  const text = String(checkpoint?.text ?? "").trim()
  const created = Number(checkpoint?.createdAt ?? 0)
  if (!messageID || !text || !Number.isFinite(created) || created <= 0) return null
  return { sessionID, messageID, runID: snapshot.runId, text, createdAt: created }
}

function compactToast(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines.slice(1).join(" ") || lines[0] || "Runtime V2 atualizou o progresso.").slice(0, 220)
}

function normalizedObservationUrl(value: unknown) {
  const configured = String(value ?? "").trim()
  return configured || DEFAULT_OBSERVATION_URL
}

function normalizedLiveSnapshotUrl(value: unknown) {
  const configured = String(value ?? "").trim()
  return configured || DEFAULT_LIVE_SNAPSHOT_URL
}

function compactDuration(value: unknown) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1_000) return "<1s"
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`
}

function savedContextSuffix(text: string) {
  const body = text.split(/\r?\n/).slice(1).join(" ")
  const match = body.match(/contexto salvo(?: acumulado)?\s+[\d.,]+\s+tok/i)
  return match?.[0] ?? null
}

function liveBody(checkpoint: LiveCheckpoint, snapshot: RuntimeProgressLiveSnapshot | null) {
  const checkpointLines = checkpoint.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const fallback = checkpointLines.slice(1).join(" ") || checkpointLines[0] || "Runtime V2 em execução."
  if (!snapshot || snapshot.runId !== checkpoint.runID || snapshot.run?.terminal === true) return fallback
  const terminal = Number(snapshot.progress?.terminal ?? 0)
  const total = Number(snapshot.progress?.total ?? 0)
  const percent = Number(snapshot.progress?.percent ?? 0)
  const current = Array.isArray(snapshot.current) ? snapshot.current : []
  const stages = current.map((task) => task.stage ?? task.shortTaskId).filter(Boolean).join(" + ")
  if (!(total >= 0)) return fallback

  const controlPlaneFailure = snapshot.controlPlane?.status === "degraded"
    ? snapshot.controlPlane.activeFailure?.message
    : null
  if (!stages && controlPlaneFailure) {
    const compactFailure = String(controlPlaneFailure).slice(0, 120)
    const repeated = Number(snapshot.controlPlane?.consecutiveFailures ?? 0)
    let text = `Runtime V2 · ${terminal}/${total} (${percent}%) — control-plane bloqueado · ${compactFailure}`
    if (repeated > 1) text += ` · ${repeated} reconciliações falharam`
    const saved = savedContextSuffix(checkpoint.text)
    if (saved) text += ` · ${saved}`
    return `${text}.`
  }
  if (!stages) {
    const saved = savedContextSuffix(checkpoint.text)
    return `Runtime V2 · ${terminal}/${total} (${percent}%) — reconciliando próxima etapa${saved ? ` · ${saved}` : ""}.`
  }

  let text = `Runtime V2 · ${terminal}/${total} (${percent}%) — ${stages} em execução`
  const primary = current[0]
  const liveness = primary?.liveness
  const elapsed = compactDuration(primary?.elapsedMs ?? liveness?.executorElapsedMs)
  if (liveness?.heartbeatFresh === true) {
    text += elapsed ? ` · executor ativo ${elapsed}` : " · executor ativo"
    const idle = compactDuration(liveness.idleMs)
    if (Number(liveness.idleMs ?? 0) >= 30_000 && idle) text += ` · sem nova saída ${idle}`
  } else if (liveness?.heartbeatAt) {
    const age = compactDuration(liveness.heartbeatAgeMs)
    text += age ? ` · heartbeat atrasado ${age}` : " · heartbeat atrasado"
  } else {
    text += " · aguardando heartbeat do executor"
  }
  const saved = savedContextSuffix(checkpoint.text)
  if (saved) text += ` · ${saved}`
  return `${text}.`
}

function ProgressPanel(props: { api: TuiPluginApi; checkpoint: () => LiveCheckpoint | null; liveSnapshot: () => RuntimeProgressLiveSnapshot | null }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.checkpoint()} keyed>
      {(current) => {
        const lines = current.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        const header = lines[0] || PROGRESS_PREFIX
        const body = () => liveBody(current, props.liveSnapshot())
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={theme().textMuted}>{header}</text>
            <text fg={theme().text}>{body()}</text>
          </box>
        )
      }}
    </Show>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = (rawOptions ?? {}) as PluginOptions
  const pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 250, 5000)
  const idlePollMs = boundedInteger(options.idlePollMs, DEFAULT_IDLE_POLL_MS, pollMs, 15_000)
  const messageLimit = boundedInteger(options.messageLimit, DEFAULT_MESSAGE_LIMIT, 10, 200)
  const staleAfterMs = boundedInteger(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, 30_000, 24 * 60 * 60 * 1000)
  const observationUrl = normalizedObservationUrl(options.observationUrl)
  const liveSnapshotUrl = normalizedLiveSnapshotUrl(options.liveSnapshotUrl)
  const liveSnapshotPollMs = boundedInteger(options.liveSnapshotPollMs, DEFAULT_LIVE_SNAPSHOT_POLL_MS, 1_000, 60_000)
  const instanceId = randomUUID()
  const [checkpoint, setCheckpoint] = createSignal<LiveCheckpoint | null>(null)
  const [liveSnapshot, setLiveSnapshot] = createSignal<RuntimeProgressLiveSnapshot | null>(null)

  let disposed = false
  let inFlight = false
  let lastObservedKey = ""
  let lastToastedKey = ""
  let durableObservationKey = ""
  let durableObservationFailures = 0
  let durableObservationNextAt = 0
  let attachedSessionId = ""
  let lastHeartbeatAt = 0
  let liveSnapshotInFlight = false
  let lastLiveSnapshotAt = 0
  let lastLiveRunID = ""
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const refreshLiveSnapshot = async (sessionID: string, runID: string | null = null) => {
    if (liveSnapshotInFlight) return liveSnapshot()
    if (runID && lastLiveRunID !== runID) {
      lastLiveRunID = runID
      lastLiveSnapshotAt = 0
      setLiveSnapshot(null)
    }
    if (Date.now() - lastLiveSnapshotAt < liveSnapshotPollMs) return liveSnapshot()
    liveSnapshotInFlight = true
    lastLiveSnapshotAt = Date.now()
    try {
      const url = new URL(liveSnapshotUrl)
      if (runID) url.searchParams.set("runId", runID)
      else url.searchParams.set("sessionId", sessionID)
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return liveSnapshot()
      const payload = await response.json() as { snapshot?: RuntimeProgressLiveSnapshot | null }
      const next = payload?.snapshot ?? null
      if (runID && next?.runId !== runID) return liveSnapshot()
      if (next?.runId) lastLiveRunID = next.runId
      setLiveSnapshot(next)
      api.renderer.requestRender()
      return next
    } catch {
      // Presentation-open: the last durable snapshot/session fallback remains visible.
      return liveSnapshot()
    } finally {
      liveSnapshotInFlight = false
    }
  }

  const observe = (event: ProjectorObservationEvent, extra: Record<string, unknown> = {}) => {
    if (!observationUrl) return
    const directory = String(api.state.path.directory ?? "").trim()
    void fetch(observationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        pluginId: PLUGIN_ID,
        instanceId,
        directory: directory || null,
        observedAt: Date.now(),
        ...extra,
      }),
      signal: AbortSignal.timeout(1_500),
    }).catch(() => undefined)
  }

  const observeDurableLiveDelivery = async (extra: Record<string, unknown>) => {
    if (!observationUrl) return false
    const directory = String(api.state.path.directory ?? "").trim()
    try {
      const response = await fetch(observationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "progress.live_delivery_observed",
          pluginId: PLUGIN_ID,
          instanceId,
          directory: directory || null,
          observedAt: Date.now(),
          ...extra,
        }),
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) return false
      const payload = await response.json() as { durable?: { persisted?: boolean } | null }
      return payload?.durable?.persisted === true
    } catch {
      return false
    }
  }

  const markAttached = (sessionID: string) => {
    if (attachedSessionId !== sessionID) {
      if (attachedSessionId) observe("progress.live_projector_detached", { sessionId: attachedSessionId })
      attachedSessionId = sessionID
      lastHeartbeatAt = Date.now()
      observe("progress.live_projector_attached", { sessionId: sessionID })
      observe("progress.live_projector_heartbeat", { sessionId: sessionID, pollMs })
      return
    }
    const now = Date.now()
    if (now - lastHeartbeatAt >= 10_000) {
      lastHeartbeatAt = now
      observe("progress.live_projector_heartbeat", { sessionId: sessionID, pollMs })
    }
  }

  const markDetached = () => {
    if (!attachedSessionId) return
    observe("progress.live_projector_detached", { sessionId: attachedSessionId })
    attachedSessionId = ""
    lastHeartbeatAt = 0
  }

  api.slots.register({
    order: 25,
    slots: {
      app_bottom() {
        return <ProgressPanel api={api} checkpoint={checkpoint} liveSnapshot={liveSnapshot} />
      },
    },
  })
  observe("progress.live_projector_loaded")

  const poll = async () => {
    if (disposed || inFlight || api.lifecycle.signal.aborted) return
    const route = api.route.current
    if (route.name !== "session") {
      markDetached()
      setCheckpoint(null)
      setLiveSnapshot(null)
      lastLiveRunID = ""
      lastObservedKey = ""
      api.renderer.requestRender()
      return
    }

    const sessionID = String(route.params?.sessionID ?? "").trim()
    if (!sessionID) return
    markAttached(sessionID)

    inFlight = true
    try {
      // R15.6.12: prefer the Context Engine durable presentation checkpoint.
      // The continuation-bound main session is intentionally not mutated while
      // parked because OpenCode can schedule phantom assistant turns after
      // silent/noReply user-message insertion. Session history remains a legacy
      // read-through fallback for checkpoints created by older Runtime revisions.
      const directory = String(api.state.path.directory ?? "").trim()
      const fetchedLive = await refreshLiveSnapshot(sessionID, null)
      let current = checkpointFromSnapshot(fetchedLive, sessionID)
      let messages: SessionMessage[] = []
      // R15.6.12: when Context Engine resolves an active run for this attached
      // session, an absent checkpoint means "not committed yet", not "search old
      // OpenCode history". Legacy history fallback is only for hosts where no
      // active Runtime run can be resolved through the session read-through.
      if (!current && !fetchedLive?.runId) {
        const response = await api.client.session.messages({
          sessionID,
          ...(directory ? { directory } : {}),
          limit: messageLimit,
        })
        messages = Array.isArray(response?.data) ? (response.data as SessionMessage[]) : []
        current = latestProgress(messages, sessionID)
      }
      if (!current || (messages.length > 0 && terminalContinuationAfter(messages, current))) {
        setCheckpoint(null)
        if (fetchedLive?.run?.terminal === true || !fetchedLive?.runId) setLiveSnapshot(null)
        api.renderer.requestRender()
        return
      }

      if (!fetchedLive || fetchedLive.runId !== current.runID) void refreshLiveSnapshot(sessionID, current.runID)
      const live = liveSnapshot()
      if (current.runID && live?.runId === current.runID && live.run?.terminal === true) {
        setCheckpoint(null)
        api.renderer.requestRender()
        return
      }
      const staleCheckpoint = Date.now() - current.createdAt > staleAfterMs
      const liveKeepsCheckpointFresh = current.runID && live?.runId === current.runID && live.run?.terminal !== true
      if (staleCheckpoint && !liveKeepsCheckpointFresh) {
        setCheckpoint(null)
        api.renderer.requestRender()
        return
      }

      setCheckpoint(current)
      api.renderer.requestRender()

      const observedKey = `${sessionID}:${current.messageID}`
      if (observedKey === lastObservedKey) return
      if (observedKey !== durableObservationKey) {
        durableObservationKey = observedKey
        durableObservationFailures = 0
        durableObservationNextAt = 0
      }

      // Toast at most once per visible checkpoint. Durable observation is retried
      // with bounded backoff instead of once per 750ms presentation poll; this
      // preserves eventual correlation without producing an unbounded rejection
      // storm when the evidence endpoint is temporarily unavailable or divergent.
      if (observedKey !== lastToastedKey) {
        lastToastedKey = observedKey
        api.ui.toast({ message: compactToast(current.text) })
      }
      if (Date.now() < durableObservationNextAt) return

      const durableObservationPersisted = await observeDurableLiveDelivery({
        runId: current.runID,
        sessionId: sessionID,
        messageId: current.messageID,
        pollMs,
        checkpointCreatedAt: current.createdAt,
        projectionLatencyMs: Math.max(0, Date.now() - current.createdAt),
      })
      if (!durableObservationPersisted) {
        const delayIndex = Math.min(durableObservationFailures, DURABLE_OBSERVATION_RETRY_DELAYS_MS.length - 1)
        const delayMs = DURABLE_OBSERVATION_RETRY_DELAYS_MS[delayIndex] ?? 30_000
        durableObservationNextAt = Date.now() + delayMs
        durableObservationFailures += 1
        return
      }
      durableObservationFailures = 0
      durableObservationNextAt = 0
      lastObservedKey = observedKey

      void api.client.app.log({
        ...(directory ? { directory } : {}),
        service: "clip-runtime-progress-tui",
        level: "info",
        message: "progress.live_delivery_observed",
        extra: {
          pluginId: PLUGIN_ID,
          instanceId,
          sessionId: sessionID,
          messageId: current.messageID,
          pollMs,
          durable: true,
        },
      }).catch(() => undefined)
    } catch {
      // Presentation-open by design: transient SDK/TUI errors must never mutate
      // Runtime authority or wake the Main Orchestrator.
    } finally {
      inFlight = false
    }
  }

  // Polling lives exclusively in the TUI presentation process; it is not Main-
  // Orchestrator observation and never calls Runtime control-plane tools. Keep
  // the 750ms fast path only while a Runtime checkpoint is visible. When the TUI
  // is idle, back off the read-through message fetch while OpenCode message/session
  // events still trigger an immediate poll. A self-rescheduling timeout also
  // guarantees that slow SDK calls cannot accumulate overlapping interval work.
  const schedulePoll = (delayMs = checkpoint() ? pollMs : idlePollMs) => {
    if (disposed || api.lifecycle.signal.aborted) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      pollTimer = null
      await poll()
      schedulePoll()
    }, delayMs)
  }
  const triggerPoll = () => {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    void poll().finally(() => schedulePoll())
  }
  api.event.on("message.updated", triggerPoll)
  api.event.on("session.idle", triggerPoll)
  api.lifecycle.onDispose(() => {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    markDetached()
    observe("progress.live_projector_disposed")
  })

  await poll()
  schedulePoll()
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
