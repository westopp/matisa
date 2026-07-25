import { Schema } from "effect"
import { methods, type Method, type Params, type Result } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// The GUI's transport. Same JSON-RPC contract as the CLI, same core method
// registry — only the framing differs (one WS message per frame instead of
// NDJSON). Params are Schema-encoded on the way out and results Schema-decoded
// on the way in, so a contract drift is a runtime error here rather than a
// silently-wrong render (contracts-single-source).
//
// Reconnect is a plain backoff loop. On every (re)connect the client replays its
// `onOpen` hooks, which is how subscriptions and PTY attaches are re-established
// — the engine holds no client state across a dropped socket.
// ────────────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "connecting" | "open" | "closed"

export interface RpcNotification {
  readonly method: string
  readonly params: unknown
}

/** A JSON-RPC error returned by the engine — carries the engine's stable code. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

const RECONNECT_BASE_MS = 300
const RECONNECT_CAP_MS = 5_000

// ── request deadlines ───────────────────────────────────────────────────────
//
// A promise that can never settle is worse than an error: the caller waits
// forever, the spinner never resolves, and nothing in the UI can tell the
// difference between "slow" and "never". A dropped socket rejects everything in
// flight, but an engine that ACCEPTS a call and then never answers it — a
// wedged handler, a deadlocked finalizer — leaves the request hanging on an
// otherwise healthy connection. Every call gets a deadline.
//
// The deadlines are per-method because the honest durations differ by orders of
// magnitude: a catalog read is milliseconds, a cold `docker pull` is minutes.
// Each one sits comfortably above the engine's own internal budget for that
// work, so a timeout here means something is genuinely wrong rather than slow.
const DEFAULT_TIMEOUT_MS = 15_000

const TIMEOUTS: Partial<Record<Method, number>> = {
  // Bounded by the image pull, which the engine allows 300s for.
  "lifecycle.start": 330_000,
  "lifecycle.restart": 330_000,
  // Bounded by the graceful stop (8s + kill) or compose down (300s + kill).
  "lifecycle.stop": 360_000,
  "docker.daemon.start": 120_000,
  "docker.daemon.stop": 120_000,
  "commands.run": 60_000,
  "logs.tail": 30_000
}

const timeoutFor = (method: Method): number => TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS

export class RpcClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly notifyHandlers = new Set<(n: RpcNotification) => void>()
  private readonly statusHandlers = new Set<(s: ConnectionStatus) => void>()
  private readonly openHandlers = new Set<() => void>()
  private attempt = 0
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  status: ConnectionStatus = "connecting"

  constructor(private readonly url: string) {
    this.connect()
  }

  // —— lifecycle ——

  private setStatus(next: ConnectionStatus): void {
    this.status = next
    for (const h of this.statusHandlers) h(next)
  }

  private connect(): void {
    if (this.disposed) return
    this.setStatus("connecting")

    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.setStatus("open")
      for (const h of this.openHandlers) h()
    }

    ws.onmessage = (ev) => this.receive(ev.data)

    ws.onclose = () => {
      // Every in-flight call dies with the socket; the caller decides whether to
      // retry once `onOpen` fires again.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new RpcError(-32000, "engine disconnected"))
      }
      this.pending.clear()
      this.ws = null
      this.setStatus("closed")
      this.scheduleReconnect()
    }

    // `onerror` always precedes `onclose`; reconnect is driven from there alone.
    ws.onerror = () => {}
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempt++)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.ws?.close()
  }

  // —— inbound ——

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof frame !== "object" || frame === null) return

    const f = frame as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    if (typeof f.method === "string" && f.id === undefined) {
      const n: RpcNotification = { method: f.method, params: f.params }
      for (const h of this.notifyHandlers) h(n)
      return
    }

    if (typeof f.id !== "number") return
    const pending = this.pending.get(f.id)
    if (pending === undefined) return
    this.pending.delete(f.id)
    clearTimeout(pending.timer)

    if (f.error !== undefined && f.error !== null) {
      const e = f.error as { code?: number; message?: string; data?: unknown }
      pending.reject(new RpcError(e.code ?? -32603, e.message ?? "engine error", e.data))
      return
    }
    pending.resolve(f.result)
  }

  // —— outbound ——

  /** Typed call. Params/result schemas come straight from the core registry, so
   *  renaming a method or changing a field fails to compile at the call site.
   *  Rejects with `E_ENGINE_TIMEOUT` if the engine never answers. */
  call<M extends Method>(
    method: M,
    params: Params<M>,
    opts?: { readonly timeoutMs?: number }
  ): Promise<Result<M>> {
    const entry = methods[method] as unknown as {
      params: Schema.Schema<unknown, unknown, never>
      result: Schema.Schema<unknown, unknown, never>
    }

    return new Promise<Result<M>>((resolve, reject) => {
      const ws = this.ws
      if (ws === null || ws.readyState !== WebSocket.OPEN) {
        reject(new RpcError(-32000, "engine disconnected"))
        return
      }

      let encoded: unknown
      try {
        encoded = Schema.encodeSync(entry.params)(params as unknown)
      } catch (cause) {
        reject(new RpcError(-32602, `invalid params for ${method}`, cause))
        return
      }

      const id = this.nextId++
      const timeoutMs = opts?.timeoutMs ?? timeoutFor(method)
      const timer = setTimeout(() => {
        // Drop the entry: a late reply for an abandoned id must not resolve a
        // promise the caller has already given up on.
        this.pending.delete(id)
        reject(
          new RpcError(
            -32001,
            `${method} did not respond within ${Math.round(timeoutMs / 1000)}s`,
            { code: "E_ENGINE_TIMEOUT" }
          )
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          try {
            resolve(Schema.decodeUnknownSync(entry.result)(value) as Result<M>)
          } catch (cause) {
            reject(new RpcError(-32603, `undecodable result for ${method}`, cause))
          }
        },
        reject,
        timer
      })

      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: encoded }))
    })
  }

  // —— subscriptions ——

  onNotify(handler: (n: RpcNotification) => void): () => void {
    this.notifyHandlers.add(handler)
    return () => this.notifyHandlers.delete(handler)
  }

  onStatus(handler: (s: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /** Runs now if already open, and again on every reconnect. */
  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler)
    if (this.status === "open") handler()
    return () => this.openHandlers.delete(handler)
  }
}

const DEFAULT_WS_URL = "ws://127.0.0.1:4127"

export const engineUrl = (): string =>
  (import.meta.env["VITE_MATISA_WS"] as string | undefined) ?? DEFAULT_WS_URL

export const rpc = new RpcClient(engineUrl())
