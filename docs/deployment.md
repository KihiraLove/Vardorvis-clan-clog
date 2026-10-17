# Hosting

Use Linux Docker with Compose v2 and a reverse proxy that terminates HTTPS.
For a first trial use the local build in the [README](../README.md). Complete
[configuration](environment.md) and change the initial admin password before
exposing the site. There are no earlier deployed releases to migrate.

## Published images

Publishing a GitHub Release on `main` runs acceptance, then publishes a single
multi-platform image for amd64 and arm64:

```text
ghcr.io/<repository-owner>/clan-clog:v1.0.0
ghcr.io/<repository-owner>/clan-clog:release-<full-commit-sha>
ghcr.io/<repository-owner>/clan-clog:sha-<full-commit-sha>
```

Ordinary pushes, tags and draft releases do not publish. Set `IMAGE_NAME`
to that full path and `IMAGE_TAG` to an approved published tag. Never use
`1.0.0-SNAPSHOT` as evidence of a published stable release.

## HTTPS

The default port is loopback-only. Forward your reverse proxy to
`127.0.0.1:8088`, set the HTTPS `PUBLIC_ORIGIN`, and configure verified proxy
addresses in `TRUSTED_PROXY_CIDRS`. Preserve the application security headers.

For an existing Traefik installation with an external `web` network, set
`CLOG_HOST` and the entrypoint/resolver names, then use
`compose.yaml:compose.traefik.yaml` as `COMPOSE_FILE`. Inspect
[the overlay](../compose.traefik.yaml) for your network requirements. Nginx
proxies the internal API; do not expose port 3000 or the database publicly.

## Versioned deployment

The installed launcher extracts verified infrastructure from the selected image
and records its image digest, schema and checksums. Install it on a fresh host:

```bash
sudo install -d -m 700 /srv/clan-collection-log
sudo install -m 755 infra/deploy.sh /srv/clan-collection-log/deploy.sh
# Put the non-secret .env in that directory. On the first deployment only:
CLOG_USE_TRAEFIK=false /srv/clan-collection-log/deploy.sh FULL_40_CHARACTER_RELEASE_SHA --setup-admin
```

Use `CLOG_USE_TRAEFIK=true` with the Traefik configuration above. The registry
path defaults to the upstream `clan-clog` package; set `CLOG_IMAGE_NAME` for
a fork. The operator needs Docker access, Bash, jq, flock and sha256sum.

The explicit `--setup-admin` command prints a temporary password locally.
Change it on the first login. Omit that flag on every later deployment.

Later deployments take a coordinated backup, stop writers, apply compatible
migrations, reconcile permissions and wait for health. Failure keeps evidence
under `evidence/` and does not perform an automatic rollback. Keep the installed
launcher checksum with your operator records. The optional manual deployment
workflow requires your own protected self-hosted runner and launcher checksum.

Back up before changing images or secrets. See [backup and recovery](release-recovery.md).
