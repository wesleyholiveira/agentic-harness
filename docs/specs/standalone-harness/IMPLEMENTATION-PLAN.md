# Implementation Plan — Standalone Agentic Harness

| Work item | Owner capability | Depends on | Outcome |
|---|---|---|---|
| W0 | architecture | — | freeze reusable/product boundary and R17.4.5 lineage |
| W1 | agent-runtime | W0 | distributed manifests + dynamic-DAG authority |
| W2 | agent-runtime | W0,W1 | dual-root Runtime/Context Engine wiring |
| W3 | devops | W2 | portable OpenCode/MCP/Headroom/RTK/Superpowers integration |
| W4 | database + runtime | W2 | standalone Compose, migrations and Rust worker packaging |
| W5 | structural-modernization | W1,W3,W4 | delete product artifacts, legacy registry and public command sprawl |
| W6 | verification | W3,W4,W5 | contract/static/toolchain validation, manifest and distribution ZIP |

This plan is illustrative SDD evidence for the harness repository itself. Future project work gets a fresh runtime-generated `implementationPlan` from Technical Refinement.
