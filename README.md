# turborepo-serverless-remote-cache

Self-hosted [Turborepo remote cache](https://turbo.build/repo/docs/core-concepts/remote-caching) running on AWS Lambda + S3, deployed with [SST v4](https://sst.dev). No servers to manage — pay only for what you use.

## How it works

Artifacts are stored in a private S3 bucket. Downloads redirect to a presigned S3 GET URL so the cache data never passes through Lambda. Uploads use Turbo's preflight mechanism: before each upload Turbo sends an `OPTIONS` request, the server returns a presigned S3 PUT URL, and Turbo streams the artifact directly to S3 — API Gateway is never in the upload path, so there is no size limit.

## Prerequisites

- Node.js 24+
- pnpm 10+
- An AWS account with credentials configured (`aws configure` or environment variables)

## Deploy

```bash
pnpm install
pnpm exec sst secret set TurboCacheToken <your-secret-token> --stage production
TURBO_DOMAIN=turbo.mycompany.com AWS_REGION=eu-west-1 pnpm exec sst deploy --stage production
```

`TURBO_DOMAIN` and `AWS_REGION` are optional — omit either to use the API Gateway URL or the `eu-west-1` default respectively. The deploy prints the API URL; use that as `TURBO_API` below if you haven't set a custom domain.

## Connect your repo

Add these environment variables wherever you run `turbo` — locally and in CI:

```bash
TURBO_API=https://<your-api-url>   # URL from deploy output, or your custom domain
TURBO_TOKEN=<your-secret-token>    # value you set for TurboCacheToken
TURBO_TEAM=team_local              # required — read below
TURBO_PREFLIGHT=1                  # required — read below
```

> **`TURBO_TEAM` is required and must not be omitted.**
>
> Turbo includes the team value as a query parameter on every artifact request (`slug` or `teamId`). This server validates that parameter is present and returns `400` if it is missing. Any non-empty string works — `team_local` is a reasonable default for self-hosted use.
>
> Set it as an environment variable (`TURBO_TEAM=team_local`) or in `turbo.json`:

```json
{
  "remoteCache": {
    "enabled": true,
    "teamSlug": "team_local"
  }
}
```

> **`TURBO_PREFLIGHT=1` is required and must not be omitted.**
>
> This server has no direct upload endpoint. Without preflight, Turbo attempts to PUT artifacts straight to the server and receives a 404. With preflight enabled, Turbo sends an `OPTIONS` request first, receives a presigned S3 URL, and streams the artifact directly to S3 — bypassing API Gateway entirely with no size limit.
>
> Set it as an environment variable (`TURBO_PREFLIGHT=1`) or in `turbo.json`:

```json
{
  "remoteCache": {
    "enabled": true,
    "preflight": true
  }
}
```

## Custom domain (optional)

Pass `TURBO_DOMAIN` at deploy time and SST will provision the ACM certificate and Route 53 record automatically. The hosted zone for your domain must exist in the same AWS account.

```bash
TURBO_DOMAIN=turbo.mycompany.com pnpm exec sst deploy --stage production
```

Alternatively, edit `sst.config.ts` directly — the comment in the file shows where.

## Secrets

| Secret | Description |
|---|---|
| `TurboCacheToken` | Bearer token Turbo sends with every request. Choose any strong random string. |

Rotate: `pnpm exec sst secret set TurboCacheToken <new-value> --stage production`

## Architecture

Six Lambda functions behind API Gateway V2, all in `src/index.ts`:

| Route | Handler | Purpose |
|---|---|---|
| `GET /v8/artifacts/status` | `getStatus` | Health check |
| `POST /v8/artifacts/events` | `postEvents` | Turbo telemetry (no-op) |
| `HEAD /v8/artifacts/{hash}` | `headArtifact` | Check artifact existence |
| `GET /v8/artifacts/{hash}` | `getArtifact` | Download via 307 → presigned S3 GET URL |
| `OPTIONS /v8/artifacts/{hash}` | `preflightArtifact` | Returns presigned S3 PUT URL for uploads |

Infrastructure is defined in `sst.config.ts`: one API Gateway, one private S3 bucket, one SST Secret. All resources deploy to `eu-west-1` by default. Set `AWS_REGION` at deploy time to use a different region:

```bash
AWS_REGION=us-east-1 pnpm exec sst deploy --stage production
```

Artifacts are stored under `v8/artifacts/{hash}`. Presigned URLs expire after 1 hour.

## Testing

```bash
pnpm test          # run all tests
pnpm typecheck     # TypeScript type check
pnpm lint          # Biome linter
```

The test suite in `src/index.test.ts` covers all five Lambda handlers using Vitest with mocked AWS SDK and SST dependencies — no AWS credentials required.

## Local development

```bash
pnpm exec sst dev
```

This deploys a personal stage to AWS using your local credentials and streams Lambda logs to your terminal.

## License

MIT — see [LICENSE](LICENSE).
