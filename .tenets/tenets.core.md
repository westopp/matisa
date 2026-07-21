# Core tenets

Tenets that apply to every system in this repository — services, clients, packages, and tooling — without exception. Anything more specific (service architecture, telemetry, security, testing, auth) lives in the corresponding subdirectory; when this file and a topic file overlap, the more specific tenet wins.

IDs are stable; cite them in PR descriptions, code review, and commit messages (e.g. "violates CORE-200"). Numbers are identifiers, not priorities.

---

## CORE-200: English-language text uses South African (British) English

All English-language text in this repository — code, comments, logs, errors, docs, commits, user-facing copy — uses South African (equivalent to British) English spelling, never American. External identifiers we do not own (e.g. the `Authorization` header, upstream SDK names) keep their original spelling.
