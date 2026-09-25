# drassos-engine

TypeScript durable orchestration engine. Automated tests are part of the work, not follow-up.

Run tests with the repo’s existing tooling: `npm test` (`vitest run`). Prefer the narrowest relevant suite first, then the affected package tests. Do not add a second test framework.

## Coverage

For every production change, add or update the layers that actually apply:

1. **Unit** — functions, classes, workflow primitives, state transitions, edge cases. Deterministic; minimal fakes.
2. **Integration** — persistence, PostgreSQL, workers, queues, workflow execution, tool/agent boundaries, APIs. Prefer real or production-equivalent infrastructure over mocks when the boundary is what you are verifying.
3. **End-to-end** — public/user-visible behavior and complete workflows. Include durability, restart, and resume when the feature depends on durable execution.

Do not add low-value tests to inflate counts. If a layer is not applicable, say why in the summary.

A task is not done until implementation and the applicable tests are in the same change, existing relevant tests still pass, and new tests fail if the protected behavior is broken.

## Bug fixes

Reproduce the defect in an automated test **before** changing production code. Confirm the new test fails for the expected reason, then make the smallest fix, then confirm it passes. Keep the regression test.

Use the lowest layer that faithfully reproduces the bug (unit vs integration vs e2e). Do not patch first and test later because the fix looks obvious. Do not skip, weaken, or rewrite a valid failing test to make a fix look green.

If an automated reproduction is impractical, stop and explain why, what can be automated instead, and residual risk.

## Test quality

Tests specify behavior, not private implementation. Keep them deterministic; name them by scenario and outcome; cover failure and boundary paths. No arbitrary sleeps, shared mutable state, or order dependence. Do not mock the subject under test. At integration boundaries, exercise the real boundary when practical.

When relevant, cover: step/workflow state, persisted history, retries and exhaustion, timeouts, cancellation, idempotency, duplicate delivery, worker failure/restart, durable resume, concurrency, fan-out/fan-in, agent/tool boundaries, human-in-the-loop suspend/resume, child workflows, public API/SDK. An in-memory-only pass is not enough proof that persisted recovery works.

## Execution

Do not claim completion without running the relevant tests when the environment allows it. Investigate failures; do not skip or disable tests to get green. Report what tests changed, which layers ran, the commands used, pass/fail, and anything that could not be run.
