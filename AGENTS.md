# Engineering Guidelines

## Interpretation

- Security and correctness take precedence over minimizing diff size or preserving a flawed convention.
- "Public API" means exported declarations and externally consumed contracts, including command-line interfaces, configuration, serialized data, and documented behavior.
- "External boundary" includes network input, environment variables, files, databases, queues, subprocess output, user-provided paths, and third-party APIs.
- "Potentially large" includes user-controlled collections and collections without a documented, enforced upper bound.
- "Hot path" means a path identified by profiling, benchmarks, production evidence, or an explicit project requirement.
- "Explicit user permission" includes a direct request to use a named dependency or tool. Otherwise, request approval before changing dependencies.
- When two guidelines conflict, follow the priority order below and explain any material trade-off.

## Priorities

- Prioritize security, correctness, readability, maintainability, compatibility, and then measured performance, in that order.
- Follow established project conventions unless they conflict with the user request, security, correctness, current project configuration, or this document.
- Do not reproduce an apparent bug, insecure pattern, or deprecated practice merely for consistency.
- Make the smallest coherent change required to solve the problem.
- Do not refactor unrelated code as part of a focused change.
- Prefer straightforward code over clever abstractions.
- Preserve documented behavior and compatibility unless the task explicitly requires a breaking change.
- Do not modify dependency manifests or lockfiles, vendor third-party code, or copy external implementations without explicit user permission.
- Before proposing a dependency, check whether the repository or platform already provides the required functionality.
- Do not build custom security-sensitive functionality merely to avoid adding a dependency. When a dependency is materially safer or simpler, explain the trade-off and request approval.

## Security and Trust Boundaries

- Treat all data crossing a trust boundary as untrusted.
- Validate external input at the boundary where it enters the system. Reject invalid data with actionable messages that do not expose sensitive internals.
- Enforce authentication and authorization independently. Verify authorization for the specific resource and action, including indirect object references.
- Never weaken authentication, authorization, validation, escaping, transport security, or cryptographic protections to simplify an implementation.
- Use parameterized or structured APIs for SQL, subprocess arguments, URLs, paths, and HTML output. Do not construct executable commands or queries by concatenating untrusted input.
- Normalize and constrain user-controlled paths before filesystem access. Confirm that resolved paths remain within the intended root when containment is required.
- Prevent server-side request forgery when accepting URLs or network destinations. Apply allowlists or equivalent restrictions where the system's trust model requires them.
- Escape untrusted text for its output context. Do not treat input validation as a substitute for output encoding.
- Never log secrets, credentials, authorization headers, session identifiers, private keys, access tokens, or sensitive personal data.
- Preserve the project's redaction and data-retention conventions when adding telemetry or logging.
- Use platform cryptography or an established, reviewed library. Do not invent cryptographic algorithms, protocols, token formats, or password-storage schemes.
- Use secure randomness for tokens and security-sensitive identifiers. Do not use `Math.random()` for security-sensitive values.
- Do not disable security checks, certificate validation, signature verification, or sandboxing except when the task explicitly requires a narrowly scoped test fixture.
- Avoid dynamic evaluation such as `eval`, `new Function`, or shell interpretation. If an existing design requires it, constrain inputs and document the trust assumption.
- Keep secrets out of source code, tests, fixtures, snapshots, generated artifacts, and error messages.
- Report discovered security risks that cannot be fixed within the requested scope.

## Code Structure

- Keep linear logic together. Do not split a function merely to make it shorter.
- Do not extract single-use helpers preemptively.
- Extract a helper when at least one of the following applies:
  - It is reused.
  - It isolates a genuinely complex boundary.
  - It represents a clearly named domain operation.
  - Its name replaces a nontrivial concept and makes the caller materially easier to understand.
  - It has an independent behavioral contract whose isolated tests add value beyond testing it through the caller.
- Avoid helpers that only rename a single expression or forward arguments to another function.
- Keep private helpers close to the code they support, usually below the main export when that improves top-down readability.
- Prefer early returns and guard clauses over `else` blocks and deeply nested conditionals.
- Prefer `switch` when dispatching multiple cases from the same discriminant.
- Use an inline conditional for a simple one-off branch when it remains easy to read.
- Avoid introducing abstractions for hypothetical future requirements.
- Do not duplicate an existing abstraction without first understanding why it exists.

## TypeScript

- Use `const` by default.
- Use `let` when a value genuinely represents changing local state.
- Do not use a ternary, duplicate code, or introduce an unnecessary helper solely to avoid `let`.
- Prefer immutable data when it improves reasoning and safety.
- Local mutation is acceptable when it is contained, clear, and avoids unnecessary allocations.
- Avoid mutating an object's shape after creation, especially in hot paths.
- Initialize objects with their complete expected shape when practical.
- Make ownership of mutable data clear. Do not mutate values owned by callers unless the API contract permits it.
- Avoid hidden shared state. When shared state is necessary, make its lifecycle and synchronization explicit.
- Use inference for obvious local variables, callbacks, and private implementation details.
- Exported functions and public methods must have explicit return types.
- Add explicit return types to private functions when they document a non-obvious contract, prevent accidental widening, or improve error detection.
- Keep the public API of each module fully typed. Do not expose inferred implementation accidents as public contracts.
- Prefer `unknown` over `any`.
- Use `any` only when required by an external API or a sound generic abstraction that cannot be expressed otherwise. Keep it local, prevent it from leaking into public types, and document non-obvious uses.
- Use discriminated unions and exhaustive checks when modeling multiple states.
- Use runtime validation and type guards at external boundaries. Static types do not validate runtime data.
- Prefer narrowing, validation, and type guards over type assertions.
- Use a type assertion only after the runtime invariant has already been established and TypeScript cannot express it cleanly.
- Keep assertions local and document non-obvious invariants.
- Never use an assertion solely to silence a compiler error.
- Avoid non-null assertions unless the invariant is local, obvious, and guaranteed.
- Model invalid states out of the type system when doing so remains readable.
- Add comments to complex type-level logic explaining the invariant or reasoning, not restating the syntax.
- Mark parameters and exposed collections as `readonly` when callers are not expected to mutate them.
- Do not add `readonly` when mutation is part of the API's intended contract.
- Remember that TypeScript `readonly` is a shallow compile-time constraint; it does not freeze runtime values.
- Do not clone data solely to satisfy a stylistic `readonly` preference.
- Use `field?: T` when a property may be absent.
- Use `field: T | undefined` when a property must exist but its value may be `undefined`.
- Do not interchange optional and explicitly undefined properties solely for stylistic consistency.
- Enable `exactOptionalPropertyTypes` for new configurations when compatible with the project. Do not change compiler options in a focused task without assessing repository-wide impact.
- If `[Symbol.dispose]` is implemented on a resource, prefer a `using` declaration over a `try-finally` block.

## Error Handling

- Let unexpected errors propagate unless the current layer can handle them meaningfully.
- Use `try`/`catch` only when the current layer can:
  - Recover from the error.
  - Add useful contextual information.
  - Translate it into a domain-specific error.
  - Intentionally handle an expected failure.
- Use `try`/`finally` for cleanup that must run regardless of success or failure.
- Do not catch an error solely to perform unconditional cleanup.
- Do not catch an error only to rethrow it unchanged.
- Preserve the original error as `cause` when wrapping it.
- Do not ignore errors accidentally.
- Suppress an error only when failure is expected and non-actionable. Make that decision clear in code or a comment when it is not obvious.
- Do not allow a secondary cleanup error to hide the primary error.
- Preserve useful error categories and status codes across layers when they are part of the contract.
- Do not expose stack traces, secrets, queries, internal paths, or sensitive implementation details to untrusted clients.

## Bun and Platform APIs

- Prefer Bun-native APIs in Bun-only runtime code when they are supported, clear, and appropriate for the task.
- Preserve portability in modules intended for browsers, Node.js, workers, libraries, or multiple runtimes.
- Do not replace an established project abstraction merely to use a Bun-native API.
- Follow framework lifecycle, request, response, and server abstractions when the project uses a framework.
- In Bun-only code, prefer when appropriate:
  - `Bun.file()` and `Bun.write()` for file I/O.
  - `Bun.spawn()` for subprocesses.
  - `Bun.serve()` for HTTP servers not managed by a framework.
  - `Glob` from `bun` for filesystem globbing.
  - `CryptoHasher` from `bun` for non-password hashing.
- Use `node:path` for path manipulation when compatible with the runtime targets.
- Prefer standard Web APIs such as `fetch`, `Request`, `Response`, `URL`, and `ReadableStream` when they fit the task and runtime targets.
- Avoid adding dependencies for functionality already provided adequately by Bun, the target runtime, or the repository.
- For local debugging, prefer logging structured values directly rather than manually formatting them.
- For production logs, follow the project's logging and serialization conventions. Use `JSON.stringify` when the logging contract requires serialized JSON, not solely for cosmetic formatting.
- Redact sensitive fields before logging or serialization.

### Bun FFI

- When declaring a FFI symbol table, add the function signature as a comment above each symbol. Example:

  ```typescript
  // C signature:
  // uint64_t csv_parser_finish_count_where_in(void* parser, uint32_t filter_column, const uint8_t* values_data,
  //                                          uint64_t values_data_len, const uint32_t* value_offsets,
  //                                          uint64_t value_count)
  csv_parser_finish_count_where_in: {
    args: [
      'ptr', // void* parser
      'u32', // uint32_t filter_column
      'buffer', // const uint8_t* values_data
      'u64', // uint64_t values_data_len
      'buffer', // const uint32_t* value_offsets
      'u64' // uint64_t value_count
    ],
    returns: 'u64',
  },
  ```

### Bun HTML Parsing and Generation

- Prefer Bun's `HTMLRewriter` for selector-based HTML extraction or transformation in Bun-only code.
- Use `HTMLRewriter` when processing can be performed incrementally without constructing a complete DOM.
- Account for streaming and chunked text callbacks. Do not assume a callback receives an entire logical text node.
- Do not use `HTMLRewriter` as an HTML sanitizer.
- Do not use `HTMLRewriter` for XML, XHTML, namespace-sensitive formats, or cases requiring XML entity and case semantics.
- Suggest another parser when the task requires:
  - Strict XML semantics.
  - Random access to a complete document tree.
  - Complex traversal across distant nodes.
  - DOM APIs unavailable through `HTMLRewriter`.
- Escape untrusted text and attribute values for the correct context, or use an approved sanitizer when untrusted HTML must be accepted.
- Do not add wrapper elements unless they serve a semantic, accessibility, layout, or component-boundary purpose.
- Preserve semantic HTML and accessibility requirements when generating or transforming markup.

## Asynchronous Code

- Do not replace `setImmediate()` with `queueMicrotask()` mechanically; choose the scheduling primitive according to the required semantics.
- Use `queueMicrotask()` only for work that must run after the current synchronous operation but before the next event-loop task.
- Avoid wrapping an existing promise in another `new Promise()`.
- Use `Promise.all()` for a small, bounded set of independent operations when fail-fast behavior is desired.
- Use bounded concurrency for large, user-controlled, or unknown-size collections.
- Use `Promise.allSettled()` when failures must be collected independently.
- Do not introduce concurrent side effects when execution order matters.
- If operations may run concurrently but results must retain input order, preserve or restore result ordering explicitly.
- Propagate `AbortSignal` through cancellable I/O when the surrounding API supports cancellation.
- Apply explicit timeouts to remote operations when the caller or framework does not already provide an appropriate one.
- Await promises or explicitly handle rejections when intentionally launching detached work.
- Make detached work observable and compatible with application shutdown when its completion matters.
- Do not assume rejecting `Promise.all()` cancels operations that have already started.

## Resources and Cleanup

- Release files, streams, sockets, database connections, locks, timers, subprocesses, and subscriptions according to their lifecycle.
- Prefer structured disposal APIs when the runtime and project support them.
- Make cleanup idempotent when multiple shutdown or error paths may invoke it.
- Do not leave background resources active after tests.
- Handle partial initialization: clean up resources that were acquired before a later initialization step failed.

## Performance

- Write clear, straightforward code first.
- Optimize only when performance matters for the specific code path.
- Prefer measurements over assumptions.
- Scope allocation-sensitive rules to hot paths; do not make cold code harder to understand to avoid insignificant allocations.
- In hot paths:
  - Avoid unnecessary array and string copies.
  - Avoid temporary objects that can be eliminated cleanly.
  - Keep object shapes stable.
  - Avoid repeated parsing, normalization, or conversion of the same value.
- Simple string concatenation is acceptable for building strings.
- For large or performance-sensitive string construction, benchmark realistic alternatives.
- Choose algorithms based on actual input constraints, not asymptotic complexity alone.
- Do not replace a simple algorithm solely because it is theoretically `O(n log n)` when the dataset is known and enforced to be small.
- Do not add caching without a clear invalidation strategy, ownership model, and memory bound.
- Do not make performance claims without measurements when the difference affects design complexity.
- Do not trade away security or correctness for performance without an explicit requirement and documented evidence.

## Benchmarks

- Use the repository's existing benchmark framework and runner.
- In this repository, use `mitata` for microbenchmarks when it is already installed:
  - Place benchmarks under `bench/`.
  - Name benchmark files `*.bench.ts`.
  - Benchmark files register benchmarks but do not call `run()`.
  - The repository's benchmark runner imports selected benchmark files and calls `run()` once.
  - Run benchmarks through the package script, for example `bun run bench -- <file-name-substring>`.
- If `mitata` or the benchmark runner is not present, do not add it without explicit user permission. Use the existing project tooling or request approval.
- Each benchmark must:
  - State the behavior or hypothesis being measured.
  - Explain why the measurement matters.
  - Include a meaningful baseline.
  - Use representative inputs, including relevant edge sizes.
  - Avoid measuring unrelated setup work.
  - Consume or validate results so the measured work cannot be discarded.
- Benchmark the complete relevant operation, not only an artificially isolated fragment, when end-to-end behavior is what matters.
- Control warmup, runtime variability, and environmental differences enough for the decision being made.
- Keep benchmark-driven optimizations only when the improvement justifies the added complexity.
- For CPU and memory profiling, follow the current [Bun project benchmarking guidance](https://bun.com/docs/project/benchmarking) when Bun is the target runtime.

## Tests

- Add or update tests when behavior changes.
- For bug fixes, add a regression test that fails before the fix and passes after it when practical.
- Test observable behavior and contracts rather than private implementation details.
- Cover relevant failure paths, boundary conditions, and security checks, not only the happy path.
- Keep tests deterministic. Control time, randomness, concurrency, network access, and environment state where they affect results.
- Do not make tests pass by weakening assertions, skipping them, adding arbitrary delays, or suppressing real failures.
- Do not contact production services from automated tests.
- Use focused test doubles at external boundaries. Avoid mocking so much internal behavior that the test can pass while the feature is broken.
- Preserve the project's conventions for fixtures, snapshots, and integration tests.
- Review snapshot changes as code; do not accept them mechanically.

## Compatibility and Data Changes

- Treat exported types, serialized formats, configuration keys, environment variables, command-line behavior, database schemas, and documented errors as compatibility-sensitive contracts.
- Do not introduce a breaking change unless the task requires it. Call out unavoidable breaking changes explicitly.
- When changing a public contract, update its documentation, tests, callers, and migration path together.
- For schema or data migrations, validate forward migration and operational compatibility with the deployed application versions that may coexist.
- Do not rewrite existing migration history unless the task explicitly requires it and the migrations have not been released or applied.
- Make data migrations resumable or safely repeatable when partial execution is possible.
- Back up or provide a recovery path before destructive data transformations when the task includes operational execution.

## Generated, Vendored, and Third-Party Files

- Do not manually edit generated files when the source and generator are available. Change the source and regenerate through the repository's established command.
- Do not format generated, vendored, fixture, snapshot, migration-history, or third-party files unless the task specifically requires it.
- Keep generated output changes scoped to the source change and review them for unexpected churn.
- Do not copy code from external sources without confirming license compatibility and obtaining permission when it introduces third-party code.
- Do not modify lockfiles unless a dependency or package metadata change requires it.

## Validation

Before completing a change:

- Inspect `package.json`, project configuration, and repository documentation to identify the actual validation commands. Do not invent script names.
- Prefer explicit package-script syntax, such as `bun run <script>`, when invoking repository scripts.
- Format only the affected source files using the repository's formatter.
- Run the relevant linter and type checker scripts.
- Run focused tests for the changed behavior.
- With Bun's test runner, use `bun run test <path-substring>` to filter test files and the appropriate test-name option when filtering by test name.
- Run the relevant build when changing exports, packaging, generated declarations, bundler configuration, runtime targets, or deployment artifacts.
- Run benchmarks when making performance-sensitive changes.
- After an approved dependency change, run `bun audit` in a Bun-managed project and any additional repository-defined dependency audit. Report when an audit command is unavailable.
- Review `git status` and the final diff.
- Revert accidental formatting, generated-file, lockfile, or unrelated changes without disturbing pre-existing user work.
- Confirm through focused tests that the intended behavior changed and known adjacent behavior remains intact.
- Report every validation step that could not be performed and the reason.

If this repository defines the following package scripts, invoke them explicitly rather than assuming they are Bun built-ins:

- `bun run fmt -- <files>`
- `bun run tsc`
- `bun run lint:biome`
- `bun run lint:oxlint`
- `bun run bench -- <filter>`

Use only scripts that actually exist in the repository, and preserve any repository-specific arguments or ordering documented for them.

## Native Code (C++)

- Assume clang as the default and only supported compiler.
- Use C++20 as the default standard.
- Use cmake as the default build system.
- Assume little-endian (x86-64, aarch64) architectures.
- Assume AVX2 and NEON instruction sets are available.
- Do not use x86-32 or other legacy architectures.
- Benchmarks should run in serial, not in parallel agents to avoid CPU sharing and maximize benchmark accuracy.
