# Packages

Drassos v0.10 ships as an SDK:

```bash
pnpm add @drassos/core @drassos/node
pnpm add -D @drassos/testing
```

| Package | Role |
| --- | --- |
| `@drassos/core` | Workflow, agent, and tool definitions. No Node infrastructure. |
| `@drassos/node` | Runtime bootstrap (`Drassos`, `createDrassos`), persistence, workers, MCP/A2A. |
| `@drassos/testing` | Isolated `createTestRuntime()` for application tests. |
| `@drassos/engine` | Implementation package used by `@drassos/node`. Prefer the packages above in new apps. |

Minimum Node.js version: **20**.

Existing examples that import `@drassos/engine` continue to work. New applications should import `@drassos/core` for definitions and `@drassos/node` to run them.
