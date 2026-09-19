# Drassos v0.10 Requirements

## SDK & npm Package Distribution

**Status:** Planned\
**Version:** 0.10.0\
**Project:** Drassos --- Agentic Workflow Engine

## 1. Purpose

Drassos v0.10 turns the engine from a repository-internal implementation
into a reusable SDK that can be consumed by applications in completely
separate repositories.

The primary goal is to establish clean package boundaries, a deliberate
public API, reliable TypeScript package artifacts, and a repeatable npm
release workflow before Drassos reaches 1.0.

v0.10 is successful when a separate Node.js/TypeScript project can
install packaged Drassos artifacts and build workflows without importing
Drassos source files or relying on repository internals.

## 2. Goals

1.  Convert the Drassos repository into a package-oriented monorepo.
2.  Publish the engine through a small number of scoped npm packages.
3.  Define an explicit public API boundary.
4.  Prevent consumers from depending on internal implementation details.
5.  Produce correct JavaScript, TypeScript declarations, source maps,
    and package metadata.
6.  Support local package validation without requiring a public npm
    release.
7.  Establish automated versioning and publishing.
8.  Provide a lightweight testing SDK for workflow consumers.
9.  Prepare Drassos for external application dogfooding in v0.11.
10. Preserve existing v0.1--v0.9 functionality.

## 3. Non-Goals

v0.10 does not:

-   Build the external reference application. That belongs to v0.11.
-   Guarantee the final v1.0 public API.
-   Split every Drassos subsystem into its own npm package.
-   Introduce major new workflow-engine features.
-   Require every runtime/storage implementation to become independently
    published.
-   Require browser execution of the workflow engine.
-   Require a hosted Drassos service.

## 4. Initial Package Model

Drassos SHOULD initially expose three packages:

``` text
@drassos/core
@drassos/node
@drassos/testing
```

Avoid premature package fragmentation. Additional packages should only
be introduced when a clear independent dependency or deployment boundary
emerges.

### 4.1 `@drassos/core`

Contains the platform-independent public engine API and core
abstractions.

Expected responsibilities include:

-   workflow definitions
-   workflow execution abstractions
-   workflow and step context
-   agents
-   tools
-   signals
-   human-in-the-loop primitives
-   child workflow primitives
-   workflow events
-   retry policies
-   state/history interfaces
-   persistence interfaces
-   worker/runtime interfaces
-   serialization contracts where appropriate
-   public errors
-   public TypeScript types

`@drassos/core` SHOULD minimize Node-specific dependencies.

Example consumer API:

``` ts
import {
  defineWorkflow,
  defineAgent,
  defineTool,
} from "@drassos/core";
```

### 4.2 `@drassos/node`

Contains the standard Node.js runtime and infrastructure implementations
required to run Drassos in a typical server environment.

Potential responsibilities include:

-   Node runtime bootstrap
-   worker process/runtime
-   PostgreSQL persistence implementation
-   HTTP/webhook integrations
-   MCP runtime integrations
-   default serialization implementations
-   telemetry/logging adapters
-   process lifecycle handling
-   Node-specific configuration

Example:

``` ts
import { Drassos } from "@drassos/node";

const drassos = new Drassos({
  database: process.env.DATABASE_URL,
});

drassos.register(myWorkflow);

await drassos.start();
```

The exact bootstrap API may differ from this example, but consumers MUST
NOT need internal Drassos imports.

### 4.3 `@drassos/testing`

Provides utilities for testing Drassos applications without requiring a
complete production deployment.

Expected capabilities:

-   in-memory or isolated runtime
-   workflow execution harness
-   deterministic test helpers where possible
-   test signal delivery
-   test human-approval responses
-   agent/tool mocking or substitution
-   workflow completion/failure assertions
-   inspection of execution history/events
-   optional virtual/fake clock support where compatible with the engine

Example target experience:

``` ts
import { createTestRuntime } from "@drassos/testing";

const runtime = createTestRuntime();

const result = await runtime.execute(myWorkflow, {
  customerId: "123",
});

expect(result.status).toBe("completed");
```

## 5. Repository Structure

The repository SHOULD move toward:

``` text
drassos/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── node/
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── testing/
│       ├── src/
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
├── examples/
│   ├── hello-workflow/
│   ├── agent-workflow/
│   └── human-approval/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

Existing source may be migrated incrementally as long as the final
package boundaries are enforceable.

## 6. Workspace Management

Use **pnpm workspaces** unless an existing project constraint makes
another workspace system materially preferable.

Root configuration MUST support:

-   installing all package dependencies
-   building all packages
-   testing all packages
-   linting all packages
-   type-checking all packages
-   dependency-aware build ordering

Internal package dependencies SHOULD use workspace references during
development.

Example:

``` json
{
  "dependencies": {
    "@drassos/core": "workspace:*"
  }
}
```

Published package manifests MUST resolve these to valid package
versions.

## 7. Public API Boundary

This is one of the most important v0.10 requirements.

Every public package MUST expose an intentional API through its
`package.json` exports.

Consumers MUST NOT rely on arbitrary deep imports.

Allowed:

``` ts
import { defineWorkflow } from "@drassos/core";
```

Potentially allowed when intentionally designed:

``` ts
import { WorkflowError } from "@drassos/core/errors";
```

Not allowed:

``` ts
import { WorkflowExecutor } from "@drassos/core/dist/internal/runtime/executor";
```

or:

``` ts
import { Something } from "@drassos/core/src/internal/foo";
```

Use the package `exports` field to enforce this boundary.

Internal implementation directories SHOULD use a recognizable convention
such as:

``` text
src/internal/
```

No symbol under an internal namespace is considered part of the public
compatibility contract.

## 8. Dependency Rules

Package dependency direction MUST remain acyclic.

Expected dependency direction:

``` text
@drassos/core
      ▲
      │
@drassos/node

@drassos/core
      ▲
      │
@drassos/testing
```

`@drassos/core` MUST NOT depend on `@drassos/node`.

Core abstractions SHOULD depend on interfaces rather than concrete
infrastructure implementations.

Circular package dependencies are prohibited.

## 9. Package Artifacts

Every publishable package MUST produce:

-   executable JavaScript
-   `.d.ts` TypeScript declarations
-   source maps
-   valid `package.json`
-   README or package documentation
-   license information
-   package export definitions

Only files required by consumers SHOULD be included in published
packages.

Repository-only files, test fixtures, internal scripts, temporary files,
and unrelated configuration SHOULD NOT be included unless needed by
consumers.

## 10. Module Compatibility

The project MUST explicitly choose and document its Node.js module
strategy.

ESM is preferred for a new TypeScript SDK unless existing Drassos
architecture creates a compelling compatibility reason otherwise.

The package configuration MUST be internally consistent across:

-   `package.json`
-   TypeScript compiler configuration
-   emitted JavaScript
-   `exports`
-   test environment
-   examples

If dual ESM/CommonJS support is implemented, it MUST be tested from
actual external consumer projects.

Do not claim support for a module format that CI does not exercise.

## 11. Node.js Support Policy

v0.10 MUST establish a documented minimum supported Node.js version.

The supported version MUST be represented in package metadata where
appropriate:

``` json
{
  "engines": {
    "node": "..."
  }
}
```

CI SHOULD test against every Node.js major version officially supported
by Drassos.

## 12. Package Versioning

All official Drassos packages SHOULD initially share the same release
version.

For v0.10:

``` text
@drassos/core@0.10.0
@drassos/node@0.10.0
@drassos/testing@0.10.0
```

Keeping versions synchronized simplifies documentation and compatibility
during the pre-1.0 period.

## 13. Changesets

Use Changesets for package release management.

The repository SHOULD support:

``` bash
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

Changesets MUST be capable of:

-   recording package changes
-   generating changelog entries
-   incrementing versions
-   updating internal dependency versions
-   preparing packages for npm publication

## 14. Local Package Validation

Developers MUST be able to validate packages as real npm artifacts
before publishing.

The preferred workflow is:

``` bash
pnpm build
pnpm pack
```

or equivalent package-specific commands.

This should produce tarballs such as:

``` text
drassos-core-0.10.0.tgz
drassos-node-0.10.0.tgz
drassos-testing-0.10.0.tgz
```

A completely separate test project MUST be able to install these
artifacts.

Example:

``` bash
pnpm add ../packages/drassos-core-0.10.0.tgz
```

The validation project MUST NOT use workspace links or source-level
imports.

## 15. Package Smoke Test

CI MUST include an external-consumer smoke test.

The test SHOULD:

1.  Build Drassos packages.
2.  Pack them into npm tarballs.
3.  Create or use an isolated fixture project outside the workspace
    dependency graph.
4.  Install the tarballs.
5.  Compile a TypeScript consumer.
6.  Start a minimal Drassos runtime where applicable.
7.  Define and execute a workflow.
8.  Verify successful completion.

This test protects against errors that normal monorepo tests can miss,
including:

-   missing package files
-   incorrect exports
-   broken declaration files
-   unresolved workspace dependencies
-   incorrect package metadata
-   missing runtime dependencies
-   accidental reliance on source files

## 16. Example Applications

The Drassos repository SHOULD contain small examples demonstrating the
supported public API.

Minimum examples:

### 16.1 Hello Workflow

Demonstrates:

-   workflow definition
-   engine startup
-   workflow execution
-   result retrieval

### 16.2 Agent Workflow

Demonstrates:

-   agent definition
-   tool registration
-   agent invocation
-   workflow/agent interaction

### 16.3 Human Approval

Demonstrates:

-   workflow suspension
-   human approval request
-   signal/resume behavior
-   workflow completion

Examples MUST consume public package exports rather than internal
implementation paths.

## 17. API Documentation

Each public package MUST document:

-   installation
-   package purpose
-   primary exports
-   minimum Node.js version
-   basic usage
-   relationship to other Drassos packages

The repository root documentation SHOULD include a quick-start
experience resembling:

``` bash
pnpm add @drassos/core @drassos/node
```

followed by the smallest realistic working workflow.

## 18. API Surface Review

Before v0.10 is considered complete, every exported symbol SHOULD be
reviewed.

For each export, determine:

-   Is this intended for application developers?
-   Is it stable enough to expose?
-   Does the name make sense outside the Drassos repository?
-   Does it leak an internal implementation detail?
-   Could an interface replace a concrete dependency?
-   Will removing or changing this later unnecessarily break consumers?

Prefer a small public API over exporting everything for convenience.

## 19. Configuration

Consumer configuration MUST not assume execution from the Drassos
repository.

Remove assumptions involving:

-   repository-relative paths
-   source-tree locations
-   root `.env` files
-   internal test configuration
-   monorepo-only dependency resolution

A consumer should be able to configure Drassos entirely from its own
application.

## 20. Error Model

Public runtime failures SHOULD use documented error types or error codes
where consumers need programmatic handling.

Internal stack details MAY remain available for debugging, but
application code SHOULD NOT need to parse error messages to identify
common engine conditions.

Potential public categories include:

-   workflow definition errors
-   workflow execution errors
-   tool execution errors
-   agent execution errors
-   persistence errors
-   signal errors
-   timeout/cancellation errors

The exact hierarchy should remain intentionally small.

## 21. Logging and Observability Compatibility

The v0.8 observability system MUST continue functioning when Drassos is
consumed through npm packages.

Observability MUST NOT depend on running inside the Drassos monorepo.

Applications SHOULD be able to configure or integrate logging/telemetry
without importing internal modules.

## 22. MCP and External Tool Compatibility

The v0.6 interoperability capabilities MUST remain usable through the
packaged SDK.

MCP configuration and external tool/agent registration MUST be
accessible through supported public APIs.

No MCP consumer should need access to internal Drassos source files.

## 23. Durable Execution Compatibility

Packaging MUST preserve durable execution semantics established in
earlier versions.

Refactoring package boundaries MUST NOT change:

-   persisted workflow behavior
-   retry semantics
-   signal semantics
-   child workflow behavior
-   workflow history semantics
-   distributed worker coordination

Any persistence format change introduced during restructuring MUST
include an explicit migration strategy.

## 24. CI Requirements

CI SHOULD include the following stages:

``` text
install
   ↓
lint
   ↓
typecheck
   ↓
unit tests
   ↓
build packages
   ↓
pack packages
   ↓
external consumer install
   ↓
external consumer compile
   ↓
external consumer smoke test
```

CI MUST fail if a publishable package cannot be consumed outside the
monorepo.

## 25. npm Publishing

The release workflow SHOULD support publication to npm under the Drassos
scope:

``` text
@drassos/core
@drassos/node
@drassos/testing
```

Before implementation, confirm that the intended npm organization/scope
and package names are available and controlled by the project owner.

Publishing SHOULD eventually be automated through CI.

Credentials/tokens MUST never be committed to the repository.

Prefer npm trusted publishing/provenance where supported by the selected
CI environment.

## 26. Pre-Release Support

Before public v0.10.0 publication, release candidates MAY be used:

``` text
0.10.0-beta.1
0.10.0-beta.2
0.10.0-rc.1
```

This is particularly useful while testing the SDK against an external
repository.

## 27. Backward Compatibility

Because Drassos remains pre-1.0, breaking API changes are permitted when
needed.

However, v0.10 SHOULD begin treating public API changes deliberately.

Changes to internal APIs do not require compatibility.

Changes to exported public APIs SHOULD:

-   be intentional
-   be documented
-   include migration notes when meaningful
-   avoid unnecessary churn

This establishes the discipline required for v1.0.

## 28. Security

Package publication MUST NOT expose:

-   npm tokens
-   test credentials
-   API keys
-   database credentials
-   private certificates
-   `.env` files
-   sensitive fixtures

The contents of each npm tarball SHOULD be inspected as part of release
validation.

## 29. Developer Commands

The root repository SHOULD expose predictable commands similar to:

``` bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm pack:all
pnpm changeset
```

Package-specific commands SHOULD also work through pnpm filtering.

## 30. Testing Requirements

### Unit Tests

Existing unit tests MUST continue to pass after restructuring.

### Package Boundary Tests

Tests SHOULD verify that:

-   internal modules cannot accidentally become supported entry points
-   `@drassos/core` does not import Node-specific implementation modules
-   package dependencies remain acyclic

### Artifact Tests

Packed artifacts MUST be tested rather than relying exclusively on
workspace execution.

### Type Tests

At least one external TypeScript fixture MUST compile using the
generated declarations.

### Runtime Smoke Tests

At least one external fixture MUST execute a real workflow through
installed package artifacts.

## 31. Migration Plan

Suggested implementation sequence:

### Phase 1 --- Workspace Foundation

-   introduce `packages/`
-   configure pnpm workspaces
-   establish shared TypeScript/build configuration
-   preserve existing tests

### Phase 2 --- Extract Core

-   identify public engine abstractions
-   move core code
-   remove Node-specific assumptions
-   define explicit exports

### Phase 3 --- Extract Node Runtime

-   move concrete Node/runtime infrastructure
-   depend on `@drassos/core`
-   expose supported runtime bootstrap APIs

### Phase 4 --- Create Testing SDK

-   extract existing useful testing utilities
-   create consumer-focused test runtime
-   provide mocking/substitution APIs

### Phase 5 --- Package Build

-   generate JS/declarations/source maps
-   configure exports/files/engines
-   validate package contents

### Phase 6 --- External Artifact Test

-   pack all packages
-   install into isolated project
-   compile and execute workflows
-   fix leaked assumptions

### Phase 7 --- Release Infrastructure

-   add Changesets
-   configure release workflow
-   validate npm scope/package names
-   optionally publish prerelease packages

### Phase 8 --- Documentation

-   package READMEs
-   root quick start
-   example applications
-   migration notes

## 32. Acceptance Criteria

v0.10 is complete when all of the following are true:

-   [ ] Drassos uses a package-oriented workspace structure.
-   [ ] `@drassos/core` builds independently.
-   [ ] `@drassos/node` builds independently.
-   [ ] `@drassos/testing` builds independently.
-   [ ] Core does not depend on Node runtime implementations.
-   [ ] Public exports are explicitly defined.
-   [ ] Unsupported deep imports are blocked.
-   [ ] Packages emit correct TypeScript declarations.
-   [ ] Packages include correct runtime dependencies.
-   [ ] Packages can be packed into npm-compatible tarballs.
-   [ ] A separate project can install those tarballs.
-   [ ] That project can compile against Drassos using TypeScript.
-   [ ] That project can define and execute a workflow.
-   [ ] No external consumer requires Drassos source-tree access.
-   [ ] Existing durable execution behavior remains intact.
-   [ ] Existing agents/tools behavior remains intact.
-   [ ] Existing signals/HITL behavior remains intact.
-   [ ] Existing child workflow behavior remains intact.
-   [ ] Existing MCP/interoperability behavior remains intact.
-   [ ] Existing distributed worker behavior remains intact.
-   [ ] Existing observability behavior remains intact.
-   [ ] CI performs an external-consumer package smoke test.
-   [ ] Changesets is configured.
-   [ ] Package documentation exists.
-   [ ] At least three public-API examples exist.
-   [ ] Package tarballs have been inspected for unintended
    files/secrets.
-   [ ] The intended npm package names/scope have been verified before
    publication.

## 33. Definition of Done

Drassos v0.10 is done when an application developer can start from an
empty Node.js/TypeScript repository, install packaged Drassos artifacts,
define workflows/agents/tools using documented public APIs, run and test
those workflows, and never need knowledge of the Drassos repository
structure or internal source code.

The v0.10 release should make the following workflow realistic:

``` bash
mkdir my-drassos-app
cd my-drassos-app

pnpm init
pnpm add @drassos/core @drassos/node
pnpm add -D @drassos/testing
```

From that point forward, the consumer interacts with **Drassos the
SDK**, not **Drassos the repository**.

## 34. Next Milestone

**v0.11 --- External Application / Dogfooding**

Build a nontrivial application in a completely separate repository using
only the packaged v0.10 public APIs.

The purpose of v0.11 is to pressure-test the SDK before v1.0 by
identifying:

-   awkward workflow authoring APIs
-   missing extension points
-   leaked implementation details
-   deployment friction
-   configuration problems
-   testing limitations
-   documentation gaps
-   APIs that should change before being declared stable
