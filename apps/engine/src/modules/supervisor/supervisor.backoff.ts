import { Duration, Schedule } from "effect"

// Restart policy. `restartDelayMs` is the pure expo-capped delay the runner uses
// between crash retries; `restartSchedule` expresses the same policy as an Effect
// Schedule (expo, capped, bounded by maxAttempts) for callers that prefer to
// drive retries declaratively.

export const restartDelayMs = (attempt: number, base: number, cap: number): number =>
  Math.min(cap, base * 2 ** attempt)

export const restartSchedule = (
  base: number,
  cap: number,
  maxAttempts: number
): Schedule.Schedule<number> =>
  Schedule.exponential(Duration.millis(base), 2).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(cap))),
    Schedule.compose(Schedule.recurs(maxAttempts))
  )
