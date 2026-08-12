import { Context, Effect, Layer } from "effect"
import { ProjectId, type ExposureKind } from "@matisa/core"
import { Store } from "../store.client.js"
import { StoreQueryError } from "../store.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// ExposuresRepo — persistence for the per-(project, kind) exposure rows the
// exposure module projects into Caddy. Rows are upserted (unique on
// project_id + kind); deletion rides the projects FK cascade, plus an explicit
// removeKind for toggling a kind off entirely. `config_json` carries
// provider-specific extras (e.g. the allocated LAN listener port).
// ────────────────────────────────────────────────────────────────────────────

export interface ExposureRecord {
  readonly projectId: ProjectId
  readonly kind: ExposureKind
  readonly enabled: boolean
  readonly hostname?: string
  readonly config?: Record<string, unknown>
}

interface ExposureRowRaw {
  readonly project_id: string
  readonly kind: string
  readonly enabled: number
  readonly hostname: string | null
  readonly config_json: string | null
}

const buildRecord = (row: ExposureRowRaw): ExposureRecord => ({
  projectId: ProjectId.make(row.project_id),
  kind: row.kind as ExposureKind,
  enabled: row.enabled !== 0,
  hostname: row.hostname ?? undefined,
  config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : undefined
})

export interface ExposuresRepoShape {
  readonly listAll: () => Effect.Effect<ReadonlyArray<ExposureRecord>, StoreQueryError>
  readonly forProject: (
    id: ProjectId
  ) => Effect.Effect<ReadonlyArray<ExposureRecord>, StoreQueryError>
  readonly upsert: (record: ExposureRecord) => Effect.Effect<void, StoreQueryError>
  readonly removeKind: (
    id: ProjectId,
    kind: ExposureKind
  ) => Effect.Effect<void, StoreQueryError>
}

export class ExposuresRepo extends Context.Tag("ExposuresRepo")<
  ExposuresRepo,
  ExposuresRepoShape
>() {}

export const ExposuresRepoLive = Layer.effect(
  ExposuresRepo,
  Effect.gen(function* () {
    const { sqlite } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const listAll: ExposuresRepoShape["listAll"] = () =>
      q(() => {
        const rows = sqlite
          .prepare("SELECT project_id, kind, enabled, hostname, config_json FROM exposures")
          .all() as ReadonlyArray<ExposureRowRaw>
        return rows.map(buildRecord)
      })

    const forProject: ExposuresRepoShape["forProject"] = (id) =>
      q(() => {
        const rows = sqlite
          .prepare(
            "SELECT project_id, kind, enabled, hostname, config_json FROM exposures WHERE project_id = ? ORDER BY kind"
          )
          .all(id) as ReadonlyArray<ExposureRowRaw>
        return rows.map(buildRecord)
      })

    const upsert: ExposuresRepoShape["upsert"] = (record) =>
      q(() => {
        sqlite
          .prepare(
            `INSERT INTO exposures (project_id, kind, enabled, hostname, config_json) VALUES (?,?,?,?,?)
             ON CONFLICT (project_id, kind) DO UPDATE SET enabled=excluded.enabled, hostname=excluded.hostname, config_json=excluded.config_json`
          )
          .run(
            record.projectId,
            record.kind,
            record.enabled ? 1 : 0,
            record.hostname ?? null,
            record.config ? JSON.stringify(record.config) : null
          )
      })

    const removeKind: ExposuresRepoShape["removeKind"] = (id, kind) =>
      q(() => {
        sqlite.prepare("DELETE FROM exposures WHERE project_id = ? AND kind = ?").run(id, kind)
      })

    return ExposuresRepo.of({ listAll, forProject, upsert, removeKind })
  })
)
