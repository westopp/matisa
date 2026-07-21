**isolated-concern** - a design principle that an entity (hook, component, function etc.) fulfils its single responsibility without reaching into its caller's world to do it. Required inputs arrive through params or props; the entity stays ignorant and agnostic to who is calling it or where those values came from. A table renders the rows it's handed - it does not fetch them. A form-hook accepts the params it needs to fetch initial values - it does not import surrounding component state to read them off the side. The entity does its job and nothing else; what it cannot see, it asks for.

**caller-agnostic** - adjective for an entity that satisfies isolated-concern.

**leaky-coupling** - the antipattern: an entity that imports or assumes things about its caller, limiting where it can be reused.

**render-agnostic** - adjective describing a config (table-config, form-config) or orchestration hook (table-hook, form-hook) that declares shape and logic without binding to any particular renderer, component library, or platform - which pgTable and pgForm both are. The associated `<name>-table.tsx` / `<name>-form.tsx` is merely a single rendering target; any number of clients can consume the same config or hook in parallel - the same product rendering its data through multiple renderers within a single app (e.g. a table on desktop and cards on mobile), multiple web UIs in the same product (admin, customer, internal tooling), a mobile UI, a native UI, a print export, a different application with a different visual identity - each owning only its own rendering. The renderer does not need to live next to the config or hook; it can be co-located for ergonomic single-app cases, or live in a shared UI package, a per-app package, or per-platform packages (web, mobile, native). Where sample code or testground code colocates a renderer next to its config, that's the convenience of the example, not a convention. Render-agnosticism is what enables isolated-concern between logic and rendering, and lets the same logic scale to multiple clients without forking - write the config and hook once, render it however each consumer needs.

**render-component** - a pure component: receives props, renders UI, imports no hooks or globals. A function of its props.

**composition-component** - a component that imports hooks, global functions, fetchers, routers, etc., orchestrates them, and wires the results down into render-components. The two roles never mix in one file.

**inline-orchestration** - logic that could be a hook, but lives in the composition-component because it's single-caller.

**inline-render** - JSX that could be a named render-component, but lives in the composition-component because it's single-caller and small.

**fetch-hook** - a hook that owns a network call (or other asynchronous resource: subscription, mutation, polling). The React-side interface to data fetching: takes the params it needs, returns the data, loading state, and error. Caller-agnostic - knows nothing about which component or feature consumes it. Plain-function transport layers (e.g. `apiClient.foo(params)`) may live below it, but React's view of the network is always through a fetch-hook.

**BYOC** - "Bring Your Own Components". A library's design posture where it ships state, APIs, and hooks but no rendered chrome - consumers supply their own React components and the library binds to them through a components-map or adapter layer. Both pgtable and pgform follow this posture: pgtable ships no `<PgTable>` chrome, pgform ships no input components.
