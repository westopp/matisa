// The --json emitter: one JSON value per line (NDJSON-friendly) so any command's
// result can be piped into jq or another tool without touching its handler.
export const toJson = (value: unknown): string => JSON.stringify(value)
