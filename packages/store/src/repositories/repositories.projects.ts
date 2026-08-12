import { Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import {
  ContextId,
  GroupSlug,
  ProjectId,
  type Command,
  type NewProject,
  type PortProtocol,
  type Project,
  type ProjectPatch
} from "@matisa/core"
import { Store } from "../store.client.js"
import { NotFound, PortConflict, StoreQueryError } from "../store.errors.js"

interface ProjectRowRaw {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly kind: string
  readonly command_json: string | null
  readonly image: string | null
  readonly compose_file: string | null
  readonly group_slug: string | null
  readonly active_context_id: string | null
  readonly path_to_icon: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface PortRowRaw {
  readonly number: number
  readonly protocol: string
  readonly description: string | null
}

const toPort = (p: PortRowRaw): Project["ports"][number] => ({
  number: p.number,
  protocol: p.protocol as PortProtocol,
  description: p.description ?? undefined
})

/** Ports arrive pre-fetched: `list` gets them in one grouped query, `get` in
 *  one lookup. buildProject issuing its own query per row made `list` an N+1 —
 *  fine at rest, but scheduleCatalogRefresh drives it at up to 5/s during a
 *  mass start.
 *
 *  No `exposure` field: exposure is per (project, kind) in its own table now,
 *  read through ExposuresRepo. `projects.exposure_json` still exists in the
 *  schema and is deliberately left unread. */
const buildProject = (row: ProjectRowRaw, ports: ReadonlyArray<PortRowRaw>): Project => ({
  id: ProjectId.make(row.id),
  name: row.name,
  root: row.root,
  kind: row.kind as Project["kind"],
  command: row.command_json ? (JSON.parse(row.command_json) as Command) : undefined,
  image: row.image ?? undefined,
  composeFile: row.compose_file ?? undefined,
  groupSlug: row.group_slug ? GroupSlug.make(row.group_slug) : undefined,
  ports: ports.map(toPort),
  activeContextId: row.active_context_id ? ContextId.make(row.active_context_id) : undefined,
  pathToIcon: row.path_to_icon ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

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

    // The hot-path statements, compiled once at layer construction. `prepare`
    // inside the handlers compiled fresh SQL on every call — ~5 statements per
    // project per list at the catalog-refresh rate.
    const stmtPortHolder = sqlite.prepare("SELECT project_id FROM ports WHERE number = ?")
    const stmtProjectById = sqlite.prepare("SELECT * FROM projects WHERE id = ?")
    const stmtProjectsAll = sqlite.prepare("SELECT * FROM projects ORDER BY created_at")
    const stmtPortsByProject = sqlite.prepare(
      "SELECT number, protocol, description FROM ports WHERE project_id = ? ORDER BY number"
    )
    // One query for every project's ports, grouped in memory. The catalog is
    // small (tens of rows) — fetching the whole table beats an IN (...) build,
    // and rows for projects not in this list simply group into unused buckets.
    const stmtPortsAll = sqlite.prepare(
      "SELECT project_id, number, protocol, description FROM ports ORDER BY number"
    )

    const isTaken: ProjectsRepoShape["isTaken"] = (port) =>
      q(() => {
        const r = stmtPortHolder.get(port) as { project_id: string } | undefined
        return r ? Option.some(ProjectId.make(r.project_id)) : Option.none<ProjectId>()
      })

    const get: ProjectsRepoShape["get"] = (id) =>
      Effect.gen(function* () {
        const row = yield* q(() => stmtProjectById.get(id) as ProjectRowRaw | undefined)
        if (!row) return yield* Effect.fail(new NotFound({ entity: "project", id }))
        return yield* q(() =>
          buildProject(row, stmtPortsByProject.all(id) as ReadonlyArray<PortRowRaw>)
        )
      })

    const list: ProjectsRepoShape["list"] = () =>
      q(() => {
        const rows = stmtProjectsAll.all() as ReadonlyArray<ProjectRowRaw>
        const portRows = stmtPortsAll.all() as ReadonlyArray<PortRowRaw & { project_id: string }>
        const byProject = new Map<string, Array<PortRowRaw>>()
        for (const p of portRows) {
          const bucket = byProject.get(p.project_id)
          if (bucket === undefined) byProject.set(p.project_id, [p])
          else bucket.push(p)
        }
        return rows.map((r) => buildProject(r, byProject.get(r.id) ?? []))
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
            "INSERT INTO projects (id, name, root, kind, command_json, image, compose_file, group_slug, active_context_id, path_to_icon, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
          ).run(
            id,
            input.name,
            input.root,
            input.kind,
            input.command ? JSON.stringify(input.command) : null,
            input.image ?? null,
            input.composeFile ?? null,
            input.groupSlug ?? null,
            null,
            input.pathToIcon ?? null,
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
          kind: input.kind,
          command: input.command,
          image: input.image,
          composeFile: input.composeFile,
          groupSlug: input.groupSlug,
          ports: input.ports,
          activeContextId: undefined,
          pathToIcon: input.pathToIcon,
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
        const image = patch.image ?? existing.image
        const composeFile = patch.composeFile ?? existing.composeFile
        // undefined = keep, null = clear, value = set
        const groupSlug =
          patch.groupSlug === undefined ? (existing.groupSlug ?? null) : patch.groupSlug
        const pathToIcon =
          patch.pathToIcon === undefined ? (existing.pathToIcon ?? null) : patch.pathToIcon
        const now = Date.now()
        yield* transaction((s) => {
          s.prepare(
            "UPDATE projects SET name=?, root=?, command_json=?, image=?, compose_file=?, group_slug=?, path_to_icon=?, updated_at=? WHERE id=?"
          ).run(
            name,
            root,
            command ? JSON.stringify(command) : null,
            image ?? null,
            composeFile ?? null,
            groupSlug,
            pathToIcon,
            now,
            id
          )
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
