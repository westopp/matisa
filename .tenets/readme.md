# Tenets

This folder is the development governance model for the systems in this repository. It defines the rules, principles, and guidelines that services, clients, and packages must follow.

## What is a tenet?

In governance and architecture contexts (e.g. AWS Well-Architected tenets, Amazon Leadership Principles), **tenets** are short, opinionated, prescriptive statements that guide decisions when trade-offs arise — stronger than guidelines, more durable than rules. They are the load-bearing beliefs you fall back on when the situation isn't covered by explicit policy.

Tenets are written for the person writing the code. They are guides to how we develop the system — rules that constrain decisions made at the keyboard, in design, and in review. A tenet must be actionable in a diff: something a reviewer can cite and an author can apply. Concerns that are not decided in code — deployment topology, infrastructure provisioning, organisational process — are not tenet material, even when they are real and important.

A tenet should be:

- **Prescriptive** — it tells you what to do, not just what to consider.
- **Opinionated** — it picks a side, even when reasonable people disagree.
- **Durable** — it holds across features, sprints, and refactors; it changes only with deliberate review.
- **Falsifiable** — you can point at code and say "this violates the tenet" or "this upholds it."

## How to read this folder

Everything specified here is **normative**. Code, documentation, and processes in this repository must follow it. When a tenet conflicts with convenience, the tenet wins. When a tenet conflicts with another tenet, the more specific one wins; if they are equally specific, the conflict itself is a signal that the governance needs an update — raise it, don't paper over it.

**Tenets are the central source of truth — they influence the code, not the other way around.** A divergence between a tenet and the current implementation is a code compliance gap, not a tenet error. The fix is to bring the code into line, or to deliberately revise the tenet through the process below; never to silently relax a tenet because the codebase happens not to satisfy it today. Aspirational reads are intentional: a tenet describes the system this codebase commits to being, not the system it currently is in every detail.

If you are an LLM or automated agent operating in this repository, treat the contents of this folder as binding instructions on par with `CLAUDE.md`. Read the relevant subdirectory before making non-trivial changes to the corresponding system.

## Structure

```
.tenets/
  services/   # Tenets for backend services (services/*)
  clients/    # Tenets for client applications (planned)
  packages/   # Tenets for shared workspace packages (packages/*)
```

- **`services/`** — governance for everything under `services/` (currently the focus). Covers service architecture, module layout, error handling, observability, testing, API contracts, and security posture.
- **`clients/`** — governance for client applications in this repository. Covers the mandatory Lighthouse quality gate and the coding disciplines that keep client builds light and fast. Where a client tenet is silent, the relevant service or core tenet applies.
- **`packages/`** — governance for shared workspaces under `packages/` (e.g. `@repo/api`, `@apollis/shared`, `@repo/testing`). Covers public surface stability, schema/contract ownership, dependency direction, and cross-consumer compatibility. Where a package tenet is silent, the consuming system's tenets apply.

## Adding or changing a tenet

A tenet is a commitment, not a suggestion. Two tests determine whether a draft is ready:

1. **A rule short enough to quote.** Stable ID, falsifiable claim. This is what reviewers and authors cite in PR descriptions and code review — if you cannot extract a quotable rule from the draft, you do not have a tenet yet.

2. **Concrete enough that a reviewer could recognise a violating diff from the text alone.** Reasoning, examples, and sanctioned exceptions all fold into this — woven through prohibition lists, inline snippets, named carve-outs, or whatever rhetoric the rule wants. The form is the author's choice; the bar is whether someone reading the tenet could flag a violation in code without further interpretation.

If you cannot meet both, the tenet is not ready.

### What this looks like

A strong tenet:

> **AUTH-200. Better-auth is the single authentication implementation.**
>
> There is one authentication implementation in this codebase: better-auth, configured in [auth.config.ts](services/server/src/modules/auth/auth.config.ts). No parallel session-cookie management, no hand-rolled password verification, no sibling token issuance, no parallel OAuth client. Where better-auth's primitives do not fit a need, the response is to extend its plugin surface — not to ship a second implementation. The bug class this closes: two divergent definitions of "authenticated" growing apart at the seams as features ship.

The rule is the first sentence. The violations are inline ("no parallel session-cookie management…"). The sanctioned escape hatch is named ("extend its plugin surface"). The failure mode lives in the closing clause. None of those wear section headings; all of them are recognisable in a diff.

Compare a draft of the same intent that does *not* meet the bar:

> **AUTH-200. Use better-auth for authentication.**
>
> Authentication should be handled consistently. Avoid rolling your own auth code where better-auth provides equivalent functionality.

The rule is present, but a reviewer reading a PR cannot decide from this whether a `crypto.createHash` password check, a custom session cookie, or a parallel OAuth client violates it. "Consistently" and "where equivalent" leave the recogniser to do the work the tenet was supposed to do. It fails the second test.

The form follows the rule, not the other way around. AUTH-200's intent fits a prohibition list because the surrounding bug class is "people ship a second implementation"; a positive structural rule (e.g. "every secret is loaded as `Redacted<T>`, propagated as `Redacted<T>`, unwrapped only at the call site that hands it to the underlying library") names its concrete shape directly without needing a list of prohibitions. Either is fine. What is not fine is text that requires a reviewer to construct the violations themselves.

## Tenet IDs

Tenets carry a stable `{PREFIX}-{NUMBER}` identifier — the prefix is shared per file (`TEST-`, `TEL-`, etc.), and numbering starts from 200 onwards. The 200 floor avoids implying hierarchy with smaller numbers (`TEL-001` reads as more important than `TEL-002`); the prefix scopes the number space per topic so additions in one area don't disturb IDs in another.

IDs are permanent. Retired tenets leave gaps rather than have their numbers reused, so external references (PR descriptions, postmortems, code comments) stay unambiguous. Reordering a file is a presentation change; it does not renumber the tenets.
