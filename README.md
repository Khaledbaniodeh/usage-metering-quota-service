# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

**Implementation Phase 0: project scaffolding and quality gates.**

The service functionality, database, Docker setup and example client are not implemented yet. They
arrive in later, separately verified phases described in [docs/architecture.md](docs/architecture.md).
Nothing in this repository should be read as a working API until those phases land.

## Requirements

- Node.js 22 (see [.nvmrc](.nvmrc); minimum `22.13.0`)
- npm (dependencies are pinned by `package-lock.json`; install with `npm ci`)

## Quality commands

| Command                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `npm run format:check`  | Verify Prettier formatting                                    |
| `npm run format`        | Apply Prettier formatting                                     |
| `npm run lint`          | ESLint (type-aware, security rules) with zero warnings        |
| `npm run typecheck`     | TypeScript type-check of source, tests, scripts and client    |
| `npm test`              | Run the test suite (Vitest)                                   |
| `npm run test:coverage` | Run tests with V8 coverage                                    |
| `npm run build`         | Compile `src/` to `dist/`                                     |
| `npm run check`         | All local quality gates: format, lint, typecheck, test, build |
