# Documentation Maintenance Contract

## Purpose

This file defines the minimum documentation system that must be maintained for a project.

It is intentionally project-agnostic.

It should work for:
- applications
- libraries
- plugins
- services
- CLIs
- SDKs
- internal tools
- infrastructure projects

## Non-Negotiable Rule

The following documents are mandatory unless the project has an explicitly better equivalent:
- `docs/product.md`
- `docs/architecture.md`
- `docs/status.md`

If any of these files do not exist, create them immediately.

If any of these files are stale, update them immediately.

Do not defer this. Do not leave it for a later pass. Do not treat it as optional.

## Required Behavior On Every Meaningful Change

Every meaningful implementation change must update the documentation in the same work pass.

That includes changes to:
- product behavior
- supported features
- commands or operator workflows
- configuration surfaces
- environment variables
- APIs or interfaces
- architecture boundaries
- file or module responsibilities
- data flow
- infrastructure assumptions
- test coverage
- verification status
- known limitations
- external dependencies
- integration gaps

If code changed and the docs were not updated, the work is incomplete.

## Required Files

### `docs/product.md`

This file is the stable product or capability contract.

It must describe what the project is supposed to do, from the user, operator, or integrator perspective.

Its features must be numbered.

Use a stable numbering scheme such as:
- `1`
- `1.1`
- `1.2`
- `4.3`

The numbering must be stable enough that `docs/status.md` can reference it directly.

It must answer, as applicable:
- what the project is
- who it is for
- what problem it solves
- what features it is supposed to provide
- what commands, endpoints, APIs, or workflows it should expose
- how configuration works
- what operators or integrators need to know
- what behavior users should expect

Refinement:
- describe the feature set in detail
- list command lines explicitly when applicable
- list APIs, endpoints, or integration surfaces explicitly when applicable
- list configuration surfaces explicitly
- do not use this file as the primary implementation status table once `docs/status.md` exists

This document should describe intended product scope clearly enough that someone can understand the project without reverse-engineering the code.

### `docs/architecture.md`

This file is the technical architecture reference.

It must describe how the project is actually structured and how it works internally.

It must answer, as applicable:
- how the system is structured
- what the important files, modules, services, or components are responsible for
- how data moves through the system
- where major boundaries exist
- what runtime assumptions exist
- what external systems or dependencies matter
- what is verified by tests
- what known integration gaps or limitations still exist

It must reflect the current implementation, not an older intended design.

### `docs/status.md`

This file tracks implementation status against the numbered features in `docs/product.md`.

It must:
- reference product feature IDs directly
- use explicit statuses such as `Implemented`, `Partial`, `Not Implemented`, `Blocked`
- include short notes explaining the real current state
- include current verification status
- include external prerequisites or blockers when relevant

Do not invent a separate unlinked feature taxonomy here. Status must map back to the product spec numbering.

## If The User Points You To This File Later

If the user references this file because documentation was missed:
1. inspect the changes that were made
2. identify every affected product, architecture, and status fact
3. update all relevant docs immediately
4. do not only patch one sentence if the real state changed more broadly

If documentation drift exists, fix the drift fully.

## Minimum Sections To Keep In Sync

### Product

At minimum keep these sections accurate, adapted to the project type:
- overview or purpose
- core concepts
- numbered features
- command surface, API surface, or workflow surface
- configuration
- integration surfaces

### Architecture

At minimum keep these sections accurate, adapted to the project type:
- current state
- structure or folder layout
- runtime model
- data model
- data flow or request flow
- component responsibilities
- testing architecture
- verification status

### Status

At minimum keep these sections accurate:
- feature ID to status mapping
- implementation notes
- verification status
- blocked or externally dependent items

## Strong Guidance For Future Iterations

When in doubt, add more concrete operational detail, not less.

Useful additions should be preserved when they materially improve future maintenance, including:
- explicit implemented vs partial vs missing distinctions
- environment prerequisites for tests
- boundaries between transport/protocol support and higher-level integration
- notes about exported-but-not-wired functionality
- documentation of current known limitations
- stable feature numbering that can survive multiple iterations

## Enforcement

Treat documentation updates as part of the definition of done.

A change is not done until:
1. code is updated
2. tests are updated or consciously deferred with reason
3. `docs/product.md` is updated
4. `docs/architecture.md` is updated
5. `docs/status.md` is updated

That is the standard.
