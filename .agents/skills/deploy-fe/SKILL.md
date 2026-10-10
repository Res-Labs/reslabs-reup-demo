---
name: deploy-fe
description: Deploy the Demo Store (apps/store) to production on a Vercel project's Vercel-assigned *.vercel.app domain. Syncs production env vars from a local env file, deploys, and probes the live URL. Use when asked to deploy, redeploy, or ship the store to Vercel.
---

# Deploy the store to Vercel

`scripts/deploy-fe.sh` does the whole deploy. It links or creates the Vercel project, sets its Root Directory to `apps/store`, syncs production env vars, deploys to production, and probes the production URL. Every step converges, so rerun the script after any failure.

## Prerequisites

- Vercel CLI, logged in (`vercel whoami`), plus `jq`, `curl`, `git`, and `tar`.
- The team slug for `--scope`. `vercel teams ls` lists it.
- A hosted Postgres. Neon from the Vercel Marketplace works. Use its pooled connection string. The store creates its tables on first use.
- An env file outside git, such as `.env.production`, that sets every variable below. The script syncs only these names, so an `AGENT_KEY` in the same file never leaves the machine.

| Variable | Production value |
|---|---|
| `MPP_SECRET_KEY` | A new random secret (`openssl rand -hex 32`). |
| `MPP_RECIPIENT` | The Moderato address that receives payments. |
| `DEMO_BATCH_ID` | The vendor batch ID of the tagged product. With any other ID, every tap answers `not_eligible`. |
| `DEMO_SKU`, `DEMO_PRICE` | The product label and the reorder price. |
| `RESLABS_LINK_ORIGIN` | `https://verify.reslabs.ai` |
| `RESLABS_SESSION_URL` | `https://api.reslabs.ai/v/p/session` |
| `TEMPO_RPC_URL` | `https://rpc.moderato.tempo.xyz` |
| `DATABASE_URL` | The hosted Postgres connection string. |
| `CRON_SECRET` | A new random secret. Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`. |
| `RESLABS_EDGE_KEY` | Optional. The key Res Labs issued for this store, sent as `x-reslabs-reup-key`. Without it, the Res Labs edge answers Vercel's network with 403. Synced only when present. |

## Run

From the repository root:

```sh
.agents/skills/deploy-fe/scripts/deploy-fe.sh --scope <team-slug> --env-file .env.production
```

`--project <name>` overrides the project name. The default is `reslabs-reup-demo`.

## What the script refuses

The script stops with `result=blocked` before it changes anything on Vercel when:

- the env file sits inside the repository and is tracked by git or not gitignored (`env_file_not_ignored`),
- a required variable is missing or empty,
- `DATABASE_URL`, `RESLABS_LINK_ORIGIN`, `RESLABS_SESSION_URL`, or `TEMPO_RPC_URL` points at `localhost`, a loopback address, or `host.docker.internal`,
- `MPP_SECRET_KEY`, `MPP_RECIPIENT`, or `DEMO_BATCH_ID` still holds its `.env.example` placeholder, or `CRON_SECRET` is `YOUR_RANDOM_SECRET`,
- the CLI is not logged in.

After it links the project, it also stops with `result=blocked` when the project has any domain outside `*.vercel.app`. Adding a custom domain needs a separate, explicit decision. Do not do it from this skill.

## How it works

- **Upload.** The script copies the files `git ls-files -co --exclude-standard` lists into a temp directory and deploys that directory. Vercel's default ignore list still uploads `.env` and `.e2e/`, which hold keys. The temp directory has no `.git`, so the CLI never connects the project to the Git repository.
- **Remote build.** Vercel builds from the whole workspace with Root Directory `apps/store`, so `@reup/chain-proof` resolves through the pnpm workspace. `apps/store/vercel.json` installs from the workspace root. A local `vercel build` followed by `vercel deploy --prebuilt` would package the local OS's binaries and Node version, so the script does not use it.
- **pnpm version.** Vercel picks pnpm 9 or 10 from the lockfile. The script sets `ENABLE_EXPERIMENTAL_COREPACK=1`, so the build uses the pnpm pinned in `package.json#packageManager`.
- **Env sync.** Each value goes to `vercel env add <NAME> production --force` on stdin, which replaces an existing value. Values never appear on argv or in output.
- **Project settings.** The CLI cannot set Root Directory, so the script `PATCH`es the project through the Vercel REST API. It reads the token from the CLI's `auth.json` into a mode 0600 header file in the temp directory and removes it on exit.
- **Cron.** `apps/store/vercel.json` calls `GET /api/cron/reconcile` daily, because Hobby plans allow only daily cron jobs. On Pro, change the schedule to `* * * * *`. Either way, the main recovery path for a `pending` attempt is the next reorder request for its tap. The cron is a backstop.
- **Protection.** Vercel's default Standard Protection keeps the production `*.vercel.app` domain public and sends per-deployment URLs to a Vercel login. The probes use the production URL for that reason.

## Verify

The script prints `deployment_url=` as soon as the deploy returns, so the URL survives a later failure. It then checks that the deployment is `READY` with target `production` and probes the production URL:

| Probe | Expected | Proves |
|---|---|---|
| `GET /` | 200 | The store serves and parses its env. |
| `GET /orders` | 200 | The store reaches Postgres. |
| `POST /api/verify` with a foreign link | 400 `bad_link` | The verify route runs and refuses the link before any charge. |
| `GET /api/cron/reconcile` without auth | 401 | The cron route is guarded. |
| `GET /api/cron/reconcile` with `CRON_SECRET` | 200 | One reconcile pass runs against the production database. |

The probes do not prove a paid reorder. To prove one, set the MCP server's `STORE_URL` to `production_url` and run one real tap through the agent. That tap pays real testnet pathUSD.

The probes also do not prove the store can reach Res Labs. Check that by hand: `POST /api/verify` with body `{"link":"https://verify.reslabs.ai/v/p?t=invalid"}` must answer 410 `link_expired`. A 502 `reslabs_unavailable` means the session endpoint answered something other than 200 or 401. The store logs that status as `res labs session answered HTTP <status>` in the deployment's runtime logs. A 403 there means the Res Labs edge is refusing Vercel's network: check `RESLABS_EDGE_KEY` is set and matches the key Res Labs holds.

## Output contract

Stdout is `key=value` lines in this order: `source=` and `dirty=`, `project=`, `project_id=`, `org_id=`, `settings=`, one `env=<NAME> synced` per variable, `deployment_url=`, `state=`, `production_url=` with `custom_domains=none`, one `probe=` line per probe, then the verdict.

| Verdict line | Exit | Meaning |
|---|---|---|
| `result=pass` | 0 | Deployed, `READY`, and every probe passed. |
| `result=fail reason=<code>` | 1 | A Vercel step or a probe failed. For `link_failed`, `env_sync_failed`, and `deploy_failed`, the last 40 CLI log lines go to stderr; other fail codes print only the verdict line. |
| `result=blocked reason=<code>` | 2 | A refusal or missing prerequisite. Nothing was deployed. |

Report the source SHA, the dirty flag, the project and project ID, the team, `deployment_url`, `production_url`, each probe result, and the verdict. Use `not-yet-recorded` for the paid reorder until a real tap has run against `production_url`. Never report an env value, the token, or their lengths.
