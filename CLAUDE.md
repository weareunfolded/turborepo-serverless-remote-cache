# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install           # install dependencies
pnpm exec sst dev           # local dev (deploys to a personal stage using your AWS identity)
pnpm exec sst deploy --stage production
TURBO_DOMAIN=turbo.mycompany.com pnpm exec sst deploy --stage production  # optional custom domain
AWS_REGION=us-east-1 pnpm exec sst deploy --stage production             # optional region (default: eu-west-1)
pnpm exec sst secret set TurboCacheToken <value> [--stage production]
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check src/
pnpm test          # vitest run
```

## Architecture

Single-service SST v4 project. All infrastructure is defined in `sst.config.ts`; all Lambda logic is in `src/index.ts`.

**Infrastructure (`sst.config.ts`)**
- `sst.aws.ApiGatewayV2` — HTTP API, outputs its URL
- `sst.aws.Bucket` (`S3TurboCache`) — private bucket, artifact storage
- `sst.Secret` (`TurboCacheToken`) — Bearer token, linked into every Lambda

**Lambda handlers (`src/index.ts`)**

| Export | Route |
|---|---|
| `getStatus` | `GET /v8/artifacts/status` |
| `postEvents` | `POST /v8/artifacts/events` (no-op, silences Turbo telemetry 404s) |
| `headArtifact` | `HEAD /v8/artifacts/{hash}` |
| `getArtifact` | `GET /v8/artifacts/{hash}` |
| `preflightArtifact` | `OPTIONS /v8/artifacts/{hash}` |

Artifacts are keyed as `v8/artifacts/{hash}` in S3.

**Auth** — Every handler calls `verifyAuth()`, which does a constant-time (`timingSafeEqual`) comparison of the `Authorization: Bearer <token>` header against `Resource.TurboCacheToken.value`.

**Download flow** — `getArtifact` does a `HeadObject` to confirm existence then returns a `307` redirect to a 1-hour presigned S3 GET URL, bypassing the ~10 MB API Gateway payload limit.

**Preflight upload flow** — When `TURBO_PREFLIGHT=1` (or `"preflight": true` in `turbo.json`), Turbo sends `OPTIONS /v8/artifacts/{hash}` before each PUT. `preflightArtifact` generates a presigned S3 PUT URL, returns it in `Location`, and sets `Access-Control-Allow-Headers` without `Authorization` so Turbo uploads directly to S3 without forwarding the Bearer token. No API Gateway size limit applies.

**Upload requires preflight** — `TURBO_PREFLIGHT=1` (or `"preflight": true` in `turbo.json`) is required. There is no direct PUT route; clients that omit preflight will receive a 404 on upload, surfacing the misconfiguration immediately.
