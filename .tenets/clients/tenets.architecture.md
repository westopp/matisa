# Architecture tenets — clients

Governance for how frontend code is organised inside a client application. The concern is not which framework or which folder names — it is which kind of logic lives where, and where the boundaries between rendering, React-coupled coordination, and framework-free computation must hold. The tenets below name those boundaries so a reviewer can recognise a violating diff without further interpretation.

Tenet IDs are stable; cite them in PR descriptions, code review, and CI output (e.g. "violates CARCH-200"). Numbers are identifiers, not priorities.

---

## CARCH-200. Logic is separated by React-dependency, not by file convention.

Frontend logic lives at one of three layers: pure functions with no React dependency, hooks that coordinate React-coupled concerns (effects, subscriptions, context), and components that render. The boundary between layer one and layer two is not aesthetic — it is load-bearing. A validation rule, a data transformation, or a derived calculation that does not need React does not belong in a hook. Placing it there couples it to React's execution model unnecessarily and makes it harder to test and reuse. If it can be a plain function, it must be.

## CARCH-201. Components do not own business logic. They own rendering decisions.

A component's job is to express what the UI looks like given its inputs. It does not fetch, does not derive complex state, does not contain conditional logic that belongs to a domain rule. When a component file contains both a network call and JSX, it has two owners and will be changed for two different reasons. That is the signal to separate. A component that is a pure function of its props and local render state is correct by default; deviation from that requires justification.

## CARCH-202. A hook owns one coherent concern. The size of that concern is bounded.

A custom hook is the right home for React-coupled logic that is reusable or too complex to live inline in a component. It is not a catch-all for everything a feature needs. A hook that fetches data, manages a form, tracks UI state, and fires analytics events has four owners and will drift. When a hook's responsibilities cannot be described in one clause — "this hook manages the submission lifecycle of the checkout form" — it is doing too much. The remedy is decomposition, not a longer name.

## CARCH-203. The decision not to separate is explicit, not lazy.

A component that mixes rendering and logic is not automatically wrong — it is wrong when that mixture carries a cost: duplication across surfaces, resistance to testing, or logic that will need to move. Simple, self-contained UI that manages one piece of local state does not need a hook extraction. The discipline is knowing the difference. Separation that produces an abstraction no one else will use, or a hook that is called exactly once and never moves, is overhead without return. Apply the pattern where it pays; document when it was considered and declined.

---
Sonner for alerts and notifications.
