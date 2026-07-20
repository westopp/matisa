import { Schema } from "effect"
import { RpcRequest } from "@matisa/core"

// The JSON-RPC envelope schemas live in @matisa/core (RpcRequest / RpcResponse /
// RpcNotification). This module holds the transport-only constants and the
// inbound-frame decoder used by the dispatcher.

/** Server→client notification method carrying a live EngineEvent. */
export const EVENTS_NOTIFY = "events.notify"

/** Server→client notification carrying a base64 chunk of pty session output. */
export const PTY_OUTPUT_NOTIFY = "pty.output"

/** Server→client notification: the pty session's process exited. */
export const PTY_EXIT_NOTIFY = "pty.exit"

export const decodeRequest = Schema.decodeUnknown(RpcRequest)
