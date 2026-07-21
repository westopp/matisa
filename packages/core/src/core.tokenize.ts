// ────────────────────────────────────────────────────────────────────────────
// POSIX-ish command tokenizer.
//
// A `Command` is { program, args }, but every human-facing surface (CLI --cmd,
// the GUI's command field) takes one shell-ish line. Splitting on whitespace
// mangles anything quoted — `node -e 'setInterval(…)'` becomes four broken
// tokens — so both clients decode through this instead. It lives in core
// because "how a command string becomes a Command" is part of the contract,
// not a per-client convenience.
//
// Rules: single quotes are literal; double quotes group with \" \\ \$ \`
// escapes; a bare backslash escapes the next character. Returns null on an
// unterminated quote so the caller can fail validation rather than guess.
// ────────────────────────────────────────────────────────────────────────────

export const tokenize = (input: string): ReadonlyArray<string> | null => {
  const out: Array<string> = []
  let cur = ""
  let started = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) cur += input[++i]!
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i]!
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(cur)
        cur = ""
        started = false
      }
    } else {
      cur += ch
      started = true
    }
  }

  if (quote !== null) return null
  if (started) out.push(cur)
  return out
}
