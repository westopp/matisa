import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import type { ResourceSample, ResourcesSnapshot } from "@matisa/core"
import { ProjectsRepo, RuntimeRepo } from "@matisa/store"
import { containerName, daemonRunning } from "../docker/docker.actions.js"
import { sh } from "../docker/docker.shell.js"

// ────────────────────────────────────────────────────────────────────────────
// Resources — on-demand CPU/RSS sampling (resources.snapshot, old-app parity).
// Sampled only when a client asks; the engine never polls in steady state.
//   process projects: one `ps` sweep, aggregated per process GROUP (the leader
//   is a session leader, so pgid == pid — grandchildren are counted).
//   docker projects: ONE `docker stats --no-stream` for every running
//   container, matched back by name — container count never changes spawn
//   count.
//   compose: skipped in the POC (stack-wide attribution is a later problem).
//
// The whole sample is behind a short TTL cache: `docker stats` costs ~1s of
// daemon work, and N clients polling must cost the same as one. Within the TTL
// every caller gets the cached snapshot; concurrent cold callers share a
// single computation.
// ────────────────────────────────────────────────────────────────────────────

export interface ResourcesShape {
  readonly snapshot: () => Effect.Effect<ResourcesSnapshot>
}

export class Resources extends Context.Tag("Resources")<Resources, ResourcesShape>() {}

/** Fresh-enough window. Clients poll on ~3s; 2s means at most one real sample
 *  per window no matter how many clients are connected. */
const SNAPSHOT_TTL_MS = 2_000

interface PsRow {
  readonly pgid: number
  readonly cpu: number
  readonly rssKb: number
}

const psSweep = (): Effect.Effect<ReadonlyArray<PsRow>> =>
  Effect.async<ReadonlyArray<PsRow>>((resume) => {
    execFile("ps", ["-ax", "-o", "pgid=,pcpu=,rss="], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resume(Effect.succeed([]))
      const rows: Array<PsRow> = []
      for (const line of stdout.split("\n")) {
        const m = line.trim().split(/\s+/)
        if (m.length < 3) continue
        const pgid = Number(m[0])
        const cpu = Number(m[1])
        const rssKb = Number(m[2])
        if (Number.isFinite(pgid) && Number.isFinite(cpu) && Number.isFinite(rssKb)) {
          rows.push({ pgid, cpu, rssKb })
        }
      }
      resume(Effect.succeed(rows))
    })
  })

const parseDockerStats = (
  json: string
): { name: string; cpu: number; rssBytes: number } | undefined => {
  try {
    const s = JSON.parse(json) as { Name?: string; CPUPerc?: string; MemUsage?: string }
    if (s.Name === undefined) return undefined
    const cpu = Number((s.CPUPerc ?? "0%").replace("%", ""))
    const mem = (s.MemUsage ?? "0B /").split("/")[0]!.trim()
    const m = /^([\d.]+)\s*(B|KiB|MiB|GiB)$/i.exec(mem)
    const mult = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }[m?.[2]?.toLowerCase() ?? "b"] ?? 1
    return {
      name: s.Name,
      cpu: Number.isFinite(cpu) ? cpu : 0,
      rssBytes: m ? Number(m[1]) * mult : 0
    }
  } catch {
    return undefined
  }
}

const make = Effect.gen(function* () {
  const runtime = yield* RuntimeRepo
  const projects = yield* ProjectsRepo

  const sample: Effect.Effect<ResourcesSnapshot> =
    Effect.gen(function* () {
      const [snaps, all] = yield* Effect.all([runtime.all(), projects.list()]).pipe(
        Effect.catchAll(() => Effect.succeed([[], []] as const))
      )
      const byId = new Map(all.map((p) => [p.id as string, p]))
      const running = snaps.filter((s) => s.state === "running")

      const samples: Array<ResourceSample> = []
      const needPs = running.filter((s) => {
        const kind = byId.get(s.projectId as string)?.kind ?? "process"
        return kind === "process" && s.pid !== undefined
      })

      if (needPs.length > 0) {
        const rows = yield* psSweep()
        for (const s of needPs) {
          const group = rows.filter((r) => r.pgid === s.pid)
          samples.push({
            projectId: s.projectId,
            pid: s.pid,
            cpuPercent: group.reduce((a, r) => a + r.cpu, 0),
            rssBytes: group.reduce((a, r) => a + r.rssKb, 0) * 1024
          })
        }
      }

      const dockerRunning = running.filter(
        (s) => byId.get(s.projectId as string)?.kind === "docker"
      )
      if (dockerRunning.length > 0 && (yield* daemonRunning())) {
        // One spawn for the lot: stats accepts many names and emits one JSON
        // object per line, carrying the container Name to match back on.
        const names = dockerRunning.flatMap((s) => {
          const project = byId.get(s.projectId as string)
          return project === undefined ? [] : [containerName(project.name)]
        })
        const stats = yield* sh(
          "docker",
          ["stats", "--no-stream", "--format", "{{json .}}", ...names],
          { timeoutMs: 10_000 }
        ).pipe(Effect.catchAll(() => Effect.succeed({ stdout: "", stderr: "" })))

        const byName = new Map(
          stats.stdout
            .split("\n")
            .map((line) => parseDockerStats(line.trim()))
            .filter((p): p is NonNullable<typeof p> => p !== undefined)
            .map((p) => [p.name, p])
        )
        for (const s of dockerRunning) {
          const project = byId.get(s.projectId as string)
          const parsed = project === undefined ? undefined : byName.get(containerName(project.name))
          if (parsed !== undefined) {
            samples.push({
              projectId: s.projectId,
              pid: s.pid,
              cpuPercent: parsed.cpu,
              rssBytes: parsed.rssBytes
            })
          }
        }
      }

      return { ts: Date.now(), samples }
    })

  // N polling clients cost one sample: fresh within the TTL is served from
  // cache, and concurrent cold callers share one computation.
  const cached = yield* Effect.cachedWithTTL(sample, SNAPSHOT_TTL_MS)

  return Resources.of({ snapshot: () => cached })
})

export const ResourcesLive = Layer.effect(Resources, make)
