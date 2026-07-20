import { Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import {
  ContextId,
  ProjectId,
  type Command,
  type Exposure,
  type NewProject,
  type PortProtocol,
  type Project,
  type ProjectPatch
} from "@matisa/core"
import { Store } from "../store.client.js"
import { NotFound, PortConflict, StoreQueryError } from "../store.errors.js"

type Sqlite = Database.Database

interface ProjectRowRaw {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly command_json: string
  readonly active_context_id: string | null
  readonly exposure_json: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface PortRowRaw {
  readonly number: number
  readonly protocol: string
  readonly description: string | null
}

const buildProject = (sqlite: Sqlite, row: ProjectRowRaw): Project => {
  const portRows = sqlite
    .prepare("SELECT number, protocol, description FROM ports WHERE project_id = ? ORDER BY number")
    .all(row.id) as ReadonlyArray<PortRowRaw>
  return {
    id: ProjectId.make(row.id),
    name: row.name,
    root: row.root,
    command: JSON.parse(row.command_json) as Command,
    ports: portRows.map((p) => ({
      number: p.number,
      protocol: p.protocol as PortProtocol,
      description: p.description ?? undefined
    })),
    activeContextId: row.active_context_id ? ContextId.make(row.active_context_id) : undefined,
    exposure: row.exposure_json ? (JSON.parse(row.exposure_json) as Exposure) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ProjectsRepo — the catalog persistence surface. `create` is atomic (project
// row + port rows in one transaction). Strict global port uniqueness is checked
// up-front and surfaced as a typed PortConflict rather than a raw SQLite throw.
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectsRepoShape {
  readonly create: (input: NewProject) => Effect.Effect<Project, PortConflict | StoreQueryError>
  readonly list: () => Effect.Effect<ReadonlyArray<Project>, StoreQueryError>
  readonly get: (id: ProjectId) => Effect.Effect<Project, NotFound | StoreQueryError>
  readonly update: (
    id: ProjectId,
    patch: ProjectPatch
  ) => Effect.Effect<Project, NotFound | PortConflict | StoreQueryError>
  readonly remove: (id: ProjectId) => Effect.Effect<void, StoreQueryError>
  /** Which project (if any) currently holds this host port. */
  readonly isTaken: (port: number) => Effect.Effect<Option.Option<ProjectId>, StoreQueryError>
}

export class ProjectsRepo extends Context.Tag("ProjectsRepo")<ProjectsRepo, ProjectsRepoShape>() {}

export const ProjectsRepoLive = Layer.effect(
  ProjectsRepo,
  Effect.gen(function* () {
    const { sqlite, transaction } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const isTaken: ProjectsRepoShape["isTaken"] = (port) =>
      q(() => {
        const r = sqlite
          .prepare("SELECT project_id FROM ports WHERE number = ?")
          .get(port) as { project_id: string } | undefined
        return r ? Option.some(ProjectId.make(r.project_id)) : Option.none<ProjectId>()
      })

    const get: ProjectsRepoShape["get"] = (id) =>
      Effect.gen(function* () {
        const row = yield* q(
          () => sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRowRaw | undefined
        )
        if (!row) return yield* Effect.fail(new NotFound({ entity: "project", id }))
        return yield* q(() => buildProject(sqlite, row))
      })

    const list: ProjectsRepoShape["list"] = () =>
      q(() => {
        const rows = sqlite
          .prepare("SELECT * FROM projects ORDER BY created_at")
          .all() as ReadonlyArray<ProjectRowRaw>
        return rows.map((r) => buildProject(sqlite, r))
      })

    const create: ProjectsRepoShape["create"] = (input) =>
      Effect.gen(function* () {
        for (const p of input.ports) {
          const holder = yield* isTaken(p.number)
          if (Option.isSome(holder)) {
            return yield* Effect.fail(new PortConflict({ port: p.number, heldBy: holder.value }))
          }
        }
        const id = randomUUID()
        const now = Date.now()
        yield* transaction((s) => {
          s.prepare(
            "INSERT INTO projects (id, name, root, command_json, active_context_id, exposure_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
          ).run(
            id,
            input.name,
            input.root,
            JSON.stringify(input.command),
            null,
            input.exposure ? JSON.stringify(input.exposure) : null,
            now,
            now
          )
          const insPort = s.prepare(
            "INSERT INTO ports (project_id, number, protocol, description) VALUES (?,?,?,?)"
          )
          for (const p of input.ports) insPort.run(id, p.number, p.protocol, p.description ?? null)
        })
        return {
          id: ProjectId.make(id),
          name: input.name,
          root: input.root,
          command: input.command,
          ports: input.ports,
          activeContextId: undefined,
          exposure: input.exposure,
          createdAt: now,
          updatedAt: now
        } satisfies Project
      })

    const update: ProjectsRepoShape["update"] = (id, patch) =>
      Effect.gen(function* () {
        const existing = yield* get(id)
        if (patch.ports) {
          for (const p of patch.ports) {
            const holder = yield* isTaken(p.number)
            if (Option.isSome(holder) && holder.value !== id) {
              return yield* Effect.fail(new PortConflict({ port: p.number, heldBy: holder.value }))
            }
          }
        }
        const name = patch.name ?? existing.name
        const root = patch.root ?? existing.root
        const command = patch.command ?? existing.command
        const exposure = patch.exposure !== undefined ? patch.exposure : existing.exposure
        const now = Date.now()
        yield* transaction((s) => {
          s.prepare(
            "UPDATE projects SET name=?, root=?, command_json=?, exposure_json=?, updated_at=? WHERE id=?"
          ).run(name, root, JSON.stringify(command), exposure ? JSON.stringify(exposure) : null, now, id)
          if (patch.ports) {
            s.prepare("DELETE FROM ports WHERE project_id=?").run(id)
            const ins = s.prepare(
              "INSERT INTO ports (project_id, number, protocol, description) VALUES (?,?,?,?)"
            )
            for (const p of patch.ports) ins.run(id, p.number, p.protocol, p.description ?? null)
          }
        })
        return yield* get(id)
      })

    const remove: ProjectsRepoShape["remove"] = (id) =>
      q(() => {
        sqlite.prepare("DELETE FROM projects WHERE id=?").run(id)
      })

    return ProjectsRepo.of({ create, list, get, update, remove, isTaken })
  })
)
