# Third-party notices

This repository contains integration configuration for third-party tools but does not claim ownership of them.

## Superpowers

`vendor/superpowers/lock.json` pins `obra/superpowers` v5.1.0 (`f2cbfbe`), licensed MIT. The recovered vendor subset is redistributed under `vendor/superpowers/LICENSE`. Complete the pinned vendor with `node scripts/vendor-superpowers.mjs` before the first fully offline stable tag.

## OpenCode

OpenCode is an external runtime/tool. The Rust worker image pins `opencode-ai@1.18.26`; host OpenCode is detected by `harness:doctor`. This repository ships configuration and harness-owned plugins, not the OpenCode binary/package source.

## Headroom, Serena, Context7, codebase-memory, Caveman and RTK

These are external integrations. The harness stores portable configuration, version pins where applicable, and local usage skills; installation/licensing of the external binaries/services remains governed by their respective projects. Secrets/API tokens are environment-only and are not vendored.
