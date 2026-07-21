import { Context, Effect, Layer } from "effect"
import type Database from "better-sqlite3"
import { ProjectId, type CommandVar, type NamedCommand } from "@matisa/core"
import { Store } from "../store.client.js"
import { NotFound, StoreQueryError } from "../store.errors.js"

type Sqlite = Database.Database

// ────────────────────────────────────────────────────────────────────────────
// CommandsRepo — named ad-hoc commands per project, each with its own env
// override rows (command_vars). Parent/child aggregate → raw prepared SQL,
// per the store convention.
// ────────────────────────────────────────────────────────────────────────────

interface CommandRowRaw {
  readonly id: number
  readonly project_id: string
  readonly name: string
  readonly command: string
}

interface VarRowRaw {
  readonly key: string
  readonly value: string
}

export interface CommandsRepoShape {
  /** Upsert by (projectId, name); replaces the command's var set atomically. */
  readonly set: (input: NamedCommand) => Effect.Effect<NamedCommand, StoreQueryError>
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<NamedCommand>, StoreQueryError>
  readonly get: (
    projectId: ProjectId,
    name: string
  ) => Effect.Effect<NamedCommand, NotFound | StoreQueryError>
  readonly remove: (projectId: ProjectId, name: string) => Effect.Effect<void, StoreQueryError>
}

export class CommandsRepo extends Context.Tag("CommandsRepo")<CommandsRepo, CommandsRepoShape>() {}

const readVars = (sqlite: Sqlite, commandId: number): ReadonlyArray<CommandVar> => {
  const rows = sqlite
    .prepare("SELECT key, value FROM command_vars WHERE command_id = ? ORDER BY key")
    .all(commandId) as ReadonlyArray<VarRowRaw>
  return rows.map((r) => ({ key: r.key, value: r.value }))
}

const toNamed = (sqlite: Sqlite, row: CommandRowRaw): NamedCommand => ({
  projectId: ProjectId.make(row.project_id),
  name: row.name,
  command: row.command,
  vars: readVars(sqlite, row.id)
})

export const CommandsRepoLive = Layer.effect(
  CommandsRepo,
  Effect.gen(function* () {
    const { sqlite, transaction } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const set: CommandsRepoShape["set"] = (input) =>
      transaction((s) => {
        s.prepare(
          "INSERT INTO commands (project_id, name, command) VALUES (?,?,?) ON CONFLICT(project_id, name) DO UPDATE SET command=excluded.command"
        ).run(input.projectId, input.name, input.command)
        const row = s
          .prepare("SELECT id FROM commands WHERE project_id = ? AND name = ?")
          .get(input.projectId, input.name) as { id: number }
        s.prepare("DELETE FROM command_vars WHERE command_id = ?").run(row.id)
        const ins = s.prepare("INSERT INTO command_vars (command_id, key, value) VALUES (?,?,?)")
        for (const v of input.vars) ins.run(row.id, v.key, v.value)
        return input
      })

    const list: CommandsRepoShape["list"] = (projectId) =>
      q(() => {
        const rows = sqlite
          .prepare("SELECT * FROM commands WHERE project_id = ? ORDER BY name")
          .all(projectId) as ReadonlyArray<CommandRowRaw>
        return rows.map((r) => toNamed(sqlite, r))
      })

    const get: CommandsRepoShape["get"] = (projectId, name) =>
      Effect.gen(function* () {
        const row = yield* q(
          () =>
            sqlite
              .prepare("SELECT * FROM commands WHERE project_id = ? AND name = ?")
              .get(projectId, name) as CommandRowRaw | undefined
        )
        if (!row) {
          return yield* Effect.fail(new NotFound({ entity: "command", id: `${projectId}/${name}` }))
        }
        return yield* q(() => toNamed(sqlite, row))
      })

    const remove: CommandsRepoShape["remove"] = (projectId, name) =>
      q(() => {
        sqlite.prepare("DELETE FROM commands WHERE project_id = ? AND name = ?").run(projectId, name)
      })

    return CommandsRepo.of({ set, list, get, remove })
  })
)
