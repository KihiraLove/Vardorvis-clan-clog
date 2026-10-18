# Hosting

Use Linux Docker, Compose v2 and an HTTPS reverse proxy. The [README](../README.md)
contains a service definition you can paste into a Compose project containing
other services. No dedicated project name, database service or secret setup is
required. Choose a unique service name, volume and host port for each installation.

## Images and storage

Published Releases on `main` run acceptance before publishing amd64/arm64 images:

```text
ghcr.io/<repository-owner>/clan-clog:v1.0.0
ghcr.io/<repository-owner>/clan-clog:release-<full-commit-sha>
ghcr.io/<repository-owner>/clan-clog:sha-<full-commit-sha>
```

Ordinary pushes, tags and drafts do not publish. Select an available release;
`1.0.0-SNAPSHOT` is not a published stable release. The repository Compose file
uses `IMAGE_NAME` and `IMAGE_TAG` from `.env`; an inline service can use a literal
image reference and needs no `.env`.

Persist `/data` in one named volume. It contains PostgreSQL 17, uploads and
credentials. Do not change container UID, mount PostgreSQL separately, or use
`down --volumes` on an installation you want to keep. See [recovery](release-recovery.md).

## HTTPS

The default port is loopback-only. Point your reverse proxy at `127.0.0.1:8088`,
set `PUBLIC_ORIGIN` to the exact HTTPS origin and configure the proxy's verified
addresses in `TRUSTED_PROXY_CIDRS` when needed. Preserve security headers.
Only port 8080 is served externally; the API and database stay private.
For a proxy on the same Docker network, use `http://clan-clog:8080` as its
upstream; the host port mapping can be omitted.

For an existing Traefik installation on network `web`, set `CLOG_HOST`, then use
`compose.yaml:compose.traefik.yaml` as `COMPOSE_FILE`. Adapt the router/service
names if hosting multiple installations behind the same Traefik.

## Updates

Take a [backup](release-recovery.md), change just this service's image tag, then:

```bash
docker compose pull clan-clog
docker compose up -d --no-deps --wait clan-clog
```

Use your selected service name in place of `clan-clog`. Accounts and credentials
remain in the volume; updates never reset the administrator.
Startup applies pending, checksummed migrations automatically. Released migrations
are immutable; new versions add forward-only migrations and preserve existing data.
After a schema upgrade, an older image may be incompatible. Restore the coordinated
backup to roll back both the database and image; do not delete migration history.

For an optional pinned updater, keep `infra/` from a reviewed release and run
from your Compose directory:

```bash
bash /path/to/infra/deploy.sh FULL_40_CHARACTER_RELEASE_SHA clan-clog
```

It verifies infrastructure and schema compatibility, backs up the selected
installation, recreates only that service, and publishes successful metadata
atomically under `.clog/clan-clog/`. Failure keeps evidence and does not downgrade
the schema. Requires Bash, jq, flock, sha256sum and Docker access.

The updater writes `.clog/clan-clog/image.yaml` with the resolved image digest.
Its helpers load this overlay automatically. For subsequent plain Compose commands,
include it in `COMPOSE_FILE` (after your own files), or copy the recorded image
into your service definition. The optional GitHub deployment workflow requires
your own protected runner and a reviewed launcher checksum; install the complete
`infra/` helper directory beside the launcher.
