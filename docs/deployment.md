# CI/CD and self-hosting

> **8 October 2026 CAT-02 update:** [Admin catalog backend](admin-catalog-backend.md) implements authenticated creation, durable PNG icons, revision-checked ordering and explicit alias reconciliation. Compose now includes an icon volume, and backups include both database and icons. Earlier descriptions of those features as pending are superseded.

## Pipeline

`CI` runs on pull requests, pushes to `main`, and manual validation. `validate` installs the lockfile, checks formatting/lint, builds all workspaces, type-checks, runs unit/database tests and checks relative doc links. `docker-smoke` builds all three images, migrates a fresh disposable database, starts Compose and checks the web/API/bot paths. Both run on GitHub-hosted runners without deployment credentials.

Only a successful **push to main** invokes reusable `Images`. It publishes:

- `ghcr.io/kihiralove/vardorvis-clan-clog-web:sha-<full commit SHA>`
- `ghcr.io/kihiralove/vardorvis-clan-clog-api:sha-<full commit SHA>`
- `ghcr.io/kihiralove/vardorvis-clan-clog-bot:sha-<full commit SHA>`

Each contains `linux/amd64` and `linux/arm64` variants. Newly published GHCR packages default to private; keep their visibility private and confirm their repository access association. Publishing uses the repository's `GITHUB_TOKEN`, never a stored push PAT. All three images must publish successfully before a release is eligible for the home workflow. A partial failed matrix is not a deployable release.

PR workflows never run on your home runner, publish packages, or use `pull_request_target`. Actions are pinned to verified commit SHAs and Dependabot tracks updates. npm dependencies are locked; base image tags receive Docker dependency updates. For tighter release reproducibility, record the produced image digests as well as SHA tags and pin deployment images by digest in a later release-manifest task.

Recommended repository rules: require `validate` and `docker-smoke` before merging, disallow force pushes to main, and restrict workflow-file changes to reviewed PRs. These are setup instructions; branch protection has not been configured automatically.

## First server installation

Install Docker/Compose on a 64-bit ARM or AMD64 Linux host. Use a dedicated directory and reverse proxy. The default web host binding is loopback, and the database/API/bot have no published ports.

```bash
sudo mkdir -p /srv/vardorvis-clan-clog
# Copy compose.yaml, .env.example and infra/deploy.sh from a reviewed main release.
# Give the dedicated deploy user ownership/access as appropriate for your host.
cd /srv/vardorvis-clan-clog
cp .env.example .env
chmod 600 .env
# Generate POSTGRES_PASSWORD and set IMAGE_TAG to a successful published SHA tag.
docker login ghcr.io -u KihiraLove
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 120
curl --fail http://127.0.0.1:8088/api/v1/status
```

Install the deployment helper as `/srv/vardorvis-clan-clog/deploy.sh` and mark it executable. It expects Compose and `.env` in the same directory. Copy updated deployment files from a reviewed release when their configuration changes; the home workflow deliberately updates image versions only and does not silently overwrite host secrets or proxy configuration.

The current containers deploy the foundation/status page, not a usable public collection log. Complete the V1 issues before announcing the site or enabling real Discord submissions.

## Reverse proxy / Traefik

The owner has supplied `https://daybloom.net/admin` as the **direct admin
navigation example**, not confirmation of a live deployment. When that is the
actual production host, configure `PUBLIC_ORIGIN=https://daybloom.net`
(**without** the `/admin` suffix) and make sure browser `Origin` is
identical. Local development may instead use an HTTP loopback origin and
must browse the exact matching hostname (`localhost` and `127.0.0.1` differ).
Do not enable the passwordless local-admin override on an internet-accessible
deployment. Confirm DNS, actual Traefik router/network/certificate resolver,
TLS certificate issuance, trusted reverse-proxy CIDRs and owner visual
acceptance before production rollout. These details remain open in
[DEC-01 / ADR 002](decisions/002-command-date-display.md).


A host-native reverse proxy can forward to `127.0.0.1:8088`. Terminate TLS there and preserve `X-Forwarded-Proto`. Later OAuth/session work must explicitly configure trusted proxy behavior; do not trust arbitrary forwarded headers from an internet-exposed API.

If Traefik itself runs in Docker, its own loopback cannot reach the host loopback binding. Add a reviewed Compose override attaching **web only** to your existing external Traefik network; route to container port 8080 with `traefik.docker.network` and `traefik.http.services.clog.loadbalancer.server.port=8080`. Keep web on the app's default network too so it can reach API. Add your own hostname/router/TLS labels and remove the host port binding if appropriate. Do not attach the database to the external proxy network. The repository does not assume your domain, network name or certificate resolver.

## Opt-in home CI/CD

`Deploy home` is manual and restricted to the main workflow definition. A GitHub-hosted verification job requires a full lowercase 40-character SHA and proves that its main push CI run concluded successfully. Only then does a runner labelled `[self-hosted, Linux, clog-production]` call the already-installed local deploy script. There is no PR checkout or execution on the home runner.

Install a dedicated runner with access to the local Docker service and GHCR pull credentials. Create the `home-production` environment, restrict who can dispatch deployments, and configure approval controls if supported by your plan. Run the workflow on main with the SHA from a successful CI run. The deploy script takes a database backup when a database is already running, pulls the selected images, waits for health and records current/previous successful release tags.

After health checks pass, the helper atomically updates only `IMAGE_TAG` in the host `.env`, preserving other configuration. Later manual Compose commands then use the same successful release. If deploying a manually installed initial release before the helper is used, record its tag in `.current-release` so the next deployment can retain it as `.previous-release`.

The workflow is opt-in: it cannot deploy until you install the runner and files. It needs no inbound SSH or open Docker socket. Automatic unattended deployment after publishing is deferred until restore/rollback and real feature health checks are proven.

## Planned uploaded icon storage

Admin-created item icons (#30/#31) need a dedicated persistent API-mounted asset volume, for example at `/data/catalog-icons`, with generated asset paths served through the API. The current foundation Compose files and deployment helper do not yet configure or back up this volume. Add its configuration and permissions when implementing the feature; never place uploaded icons only inside an image or disposable container filesystem.

The database stores icon references, canonical manual item IDs, page memberships and saved order metadata. Back up that database together with the matching published icon files, using a consistent snapshot or a controlled write pause. Restore both to an isolated deployment and verify every referenced icon, manual item, page order and existing collection/hardcore credit before release acceptance. Source catalog refreshes and image replacements must leave manual overrides and uploaded files intact. The deployment/recovery tasks (#11/#13) must extend the helper accordingly; the database-only command below covers the shipped foundation.

## Backups and rollback

```bash
mkdir -p backups
chmod 700 backups
docker compose exec -T db pg_dump -U clog -d clog -Fc > backups/clog.dump
chmod 600 backups/clog.dump
```

Keep encrypted off-host copies and protect `.env` separately. External proof images are not archived by V1; database backups preserve links only. Test restores in an isolated database regularly. Do not rely on an untested dump as recovery.

Image rollback: set `IMAGE_TAG` to the recorded previous successful tag, pull and start with the same Compose command. Migrations are forward-only and checksummed; never edit an already-applied migration. An older API may work only with compatible additive schema changes. If a schema change is incompatible, restore a tested backup to a separate volume/database and point the matching application release at it during a controlled recovery. Do not automatically run destructive down migrations.

If health checks fail, the deployment helper reports failure and does not record the release as current. It does not claim automatic database rollback. Inspect logs, then choose a compatible older image or tested database restore. A later release-manifest issue will add coordinated digest/configuration rollout and more complete recovery automation.

For shutdown, use `docker compose stop` to retain the database volume. Avoid `down --volumes` on the live server; that command is used only for disposable CI/test databases.
