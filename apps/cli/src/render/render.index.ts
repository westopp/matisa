import { Console, Context, Effect, Layer } from "effect"
import type {
  Accepted,
  DiscoveryActionResult,
  DiscoverySnapshot,
  EngineEvent,
  EnvContext,
  ExposureEntry,
  ExposureSnapshot,
  Project,
  ProjectWithState,
  RuntimeStatus
} from "@matisa/core"
import { ClientConfig } from "../config/config.client-config.js"
import * as T from "./render.table.js"
import { toJson } from "./render.json.js"
import { formatEvent } from "./render.events.js"

// ────────────────────────────────────────────────────────────────────────────
// Renderer — presentation behind a service.
//
// Each method picks table vs json by reading the resolved output mode (which the
// global --json flag can force), so command handlers stay thin: they call a
// render.* method and never branch on presentation themselves.
// ────────────────────────────────────────────────────────────────────────────

export interface RendererService {
  readonly projects: (rows: ReadonlyArray<ProjectWithState>) => Effect.Effect<void>
  readonly project: (p: Project) => Effect.Effect<void>
  readonly projectState: (p: ProjectWithState) => Effect.Effect<void>
  readonly removed: (id: string) => Effect.Effect<void>
  /** `projectName` resolves the owning project for the grouped human output;
   *  --json still emits the raw contexts, projectId included. */
  readonly envs: (
    list: ReadonlyArray<EnvContext>,
    projectName: (id: string) => string
  ) => Effect.Effect<void>
  readonly envContext: (c: EnvContext) => Effect.Effect<void>
  readonly accepted: (a: Accepted) => Effect.Effect<void>
  readonly status: (s: RuntimeStatus) => Effect.Effect<void>
  readonly exposureSnapshot: (s: ExposureSnapshot) => Effect.Effect<void>
  readonly exposureEntries: (
    id: string,
    entries: ReadonlyArray<ExposureEntry>
  ) => Effect.Effect<void>
  readonly discovery: (s: DiscoverySnapshot) => Effect.Effect<void>
  readonly discoveryAction: (r: DiscoveryActionResult) => Effect.Effect<void>
  readonly event: (e: EngineEvent) => Effect.Effect<void>
  readonly cursor: (n: number) => Effect.Effect<void>
  /** Generic sink: `value` for --json, `human` for the table mode. */
  readonly raw: (value: unknown, human: string) => Effect.Effect<void>
}

export class Renderer extends Context.Tag("matisa-cli/Renderer")<
  Renderer,
  RendererService
>() {}

const make = Effect.gen(function* () {
  const config = yield* ClientConfig

  const emit = (value: unknown, human: string) =>
    Effect.flatMap(config.outputMode, (mode) =>
      Console.log(mode === "json" ? toJson(value) : human)
    )

  return Renderer.of({
    projects: (rows) => emit(rows, T.projectsTable(rows)),
    project: (p) => emit(p, T.projectLine(p)),
    projectState: (p) => emit(p, T.projectStateLine(p)),
    removed: (id) => emit({ removed: id }, T.removedLine(id)),
    envs: (list, projectName) => emit(list, T.envTable(list, projectName)),
    envContext: (c) => emit(c, T.envContextLine(c)),
    accepted: (a) => emit(a, T.acceptedLine(a)),
    status: (s) => emit(s, T.statusLine(s)),
    exposureSnapshot: (s) => emit(s, T.exposureTable(s)),
    exposureEntries: (id, entries) => emit({ projectId: id, entries }, T.exposureEntriesLines(id, entries)),
    discovery: (s) => emit(s, T.discoveryTable(s)),
    discoveryAction: (r) => emit(r, T.discoveryActionLine(r)),
    event: (e) => emit(e, formatEvent(e)),
    cursor: (n) => emit({ nextCursor: n }, `next-cursor ${n}`),
    raw: (value, human) => emit(value, human)
  })
})

export const RendererLive = Layer.effect(Renderer, make)
