#!/usr/bin/env bash
# Extracted from the complete CI smoke gate; shared by local and release checks.
set -euo pipefail
[[ "${COMPOSE_PROJECT_NAME:-}" =~ ^clog-checks-[a-z0-9-]+$ ]] || { echo "Use npm run test:all" >&2; exit 1; }
export COMPOSE_FILE=compose.yaml:compose.checks.yaml
export COMPOSE_ENV_FILES=/dev/null COMPOSE_DISABLE_ENV_FILE=true
export CLOG_HOST=clog.example.com

printf "\nValidate Compose\n"
docker compose config --quiet

printf "\nValidate opt-in Traefik labels and private network topology\n"
docker compose -f compose.yaml -f compose.traefik.yaml config --quiet
docker compose -f compose.yaml -f compose.traefik.yaml config --format json > /tmp/clog-traefik.json
jq -e '
  (.services.app.networks | keys | sort) == ["default", "web"] and
  .services.app.environment.PUBLIC_ORIGIN == "https://clog.example.com" and
  .services.app.environment.AUTH_ENABLED == "true" and
  .networks.web.external == true and
  (.services.app.labels."traefik.docker.network" == "web") and
  (.services.app.labels."traefik.http.services.clog.loadbalancer.server.port" == "8080") and
  (.services.app.labels."traefik.http.routers.clog.tls.certresolver" == "letsencrypt") and
  (.services.app.labels."traefik.http.routers.clog.entrypoints" == "websecure") and
  ([.services | to_entries[] | select(.key != "app") | (.value.networks // {} | keys[])] | index("web") == null)
' /tmp/clog-traefik.json

printf "\nStart and smoke test\n"
docker compose up -d --wait --wait-timeout 120
# Fresh install applies the immutable baseline and forward-only upgrades.
test "$(docker compose exec -T db psql -U clog -d clog -Atc "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")" = "001_baseline.sql,002_manual_submission_requests.sql,003_staff_accounts.sql,004_runelite_submissions.sql,005_clan_api_keys.sql,006_clan_logos.sql,007_site_customization.sql,008_default_clan_name.sql,009_runelite_world_types.sql,010_hardcore_appearance.sql,011_catalog_page_management.sql,012_runelite_auto_review.sql,013_collection_log_schedules.sql,014_wom_competitions.sql,015_review_notes.sql"
curl --fail --retry 5 --retry-delay 2 http://app:8080/healthz
curl --fail http://app:8080/api/v1/status
curl --fail --output /tmp/catalog.json http://app:8080/api/v1/catalog
jq -e '(.items | length) == 1717 and (.pages | length) == 124' /tmp/catalog.json
jq -e '
  ([.pages[] | select(.id=="hard_treasure_trails_rare") | .itemIds | length] == [24]) and
  ([.pages[] | select(.id=="elite_treasure_trails_rare") | .itemIds | length] == [39]) and
  ([.pages[] | select(.id=="master_treasure_trails_rare") | .itemIds | length] == [45]) and
  ([.pages[] | select(.id=="gilded" or .id=="third_age" or .id=="mimic")] | length == 0) and
  (. as $catalog | ($catalog.items[] | select(.name=="Ring of 3rd Age") | .id) as $ring |
   ([ $catalog.pages[] | select(.id=="elite_treasure_trails" or .id=="master_treasure_trails") |
      select(.itemIds | index($ring)) ] | length) == 2)
' /tmp/catalog.json
curl --fail --output /dev/null http://app:8080/catalog/items/1249.png
curl --fail --output /tmp/collections.json http://app:8080/api/v1/collections
jq -e '.credits == []' /tmp/collections.json
curl --fail http://app:8080/api/v1/settings
curl --fail --output /tmp/xp.json http://app:8080/api/v1/xp/tracker
jq -e '(.revision == "xp-1") and (.events == []) and (.totals | .mining == "0")' /tmp/xp.json
curl --fail -sS http://app:8080/api/v1/auth/session | jq -e '.authenticated == false'
test "$(curl -sS -o /dev/null -w '%{http_code}' http://app:8080/api/v1/admin/settings)" = "401"
test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://clog.example.com' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}' \
  http://app:8080/api/v1/auth/login)" = "401"
docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

printf "\nVerify restricted database runtime and append-only receipt/audit privileges\n"
docker compose exec -T app node --input-type=module -e "
  import pg from 'pg';
  const client = new pg.Client({connectionString: process.env.DATABASE_URL});
  await client.connect();
  try {
    const current = (await client.query('SELECT current_user AS user')).rows[0].user;
    if (current !== 'clog_runtime') throw Error('API must not run as migrator');
    const roles = (await client.query(\"SELECT has_table_privilege(current_user,'public.audit_events','INSERT') AS ai, has_table_privilege(current_user,'public.audit_events','UPDATE') AS au, has_table_privilege(current_user,'public.audit_events','DELETE') AS ad, has_table_privilege(current_user,'public.catalog_audit','DELETE') AS cd, has_table_privilege(current_user,'public.xp_import_history','UPDATE') AS xu, has_table_privilege(current_user,'public.schema_migrations','SELECT') AS ms, has_table_privilege(current_user,'public.submissions','UPDATE') AS su\")).rows[0];
    if (JSON.stringify(roles) !== JSON.stringify({ai:true,au:false,ad:false,cd:false,xu:false,ms:false,su:true})) throw Error('Unexpected runtime grants: '+JSON.stringify(roles));
    for (const table of ['catalog_requests', 'catalog_page_requests', 'manual_submission_requests', 'runelite_submission_requests', 'runelite_settings_audit', 'collection_schedule_audit', 'competition_import_history']) {
      const audit = (await client.query(\"SELECT has_table_privilege(current_user, 'public.' || \$1, 'SELECT') AS read, has_table_privilege(current_user, 'public.' || \$1, 'INSERT') AS append, has_table_privilege(current_user, 'public.' || \$1, 'UPDATE') AS edit, has_table_privilege(current_user, 'public.' || \$1, 'DELETE') AS remove\", [table])).rows[0];
      if (JSON.stringify(audit) !== JSON.stringify({read:true,append:true,edit:false,remove:false})) throw Error('Unexpected audit grants: '+table);
    }
  } finally { await client.end(); }
"

printf "\nUnified WOM competitions and scheduled page imports\n"
docker compose cp scripts app:/app/scripts
docker compose exec -T -e COMPETITION_SMOKE_DISPOSABLE=true app node /app/scripts/competitions-smoke.mjs

printf "\nProxy isolation and durable manual submission retries\n"
docker compose exec -T -e REVIEW_SMOKE_TEST=1 app node --input-type=module < scripts/review-smoke.mjs

printf "\nProxy branding logos accept valid large images and enforce both upload limits\n"
docker compose exec -T -e BRANDING_PROXY_SMOKE_TEST=1 app node --input-type=module < scripts/branding-proxy-smoke.mjs

printf "\nBounded import preview maintenance respects runtime role and receipts\n"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U clog -d clog -c "
  INSERT INTO xp_previews(token_hash,actor_discord_id,expected_revision,snapshot,expires_at)
    VALUES(repeat('a',64),'ci-test-actor','xp-1','{}',now()-interval '2 hours');
  INSERT INTO competition_previews(token_hash,actor_id,expected_revision,schedule_revision,snapshot,page_ids,expires_at)
    VALUES(repeat('b',64),'ci-test-actor','xp-1','schedule-1','{}','{}',now()-interval '2 hours');
"
docker compose run --rm --no-deps -T migrate node packages/database/dist/preview-maintenance.js --dry-run > /tmp/preview-maintenance-dry.json
jq -e '.mode=="dry-run" and .tables.xp_previews.before.eligible >= 1 and .tables.competition_previews.before.eligible >= 1 and .tables.xp_previews.deleted == 0 and .tables.competition_previews.deleted == 0' /tmp/preview-maintenance-dry.json
docker compose run --rm --no-deps -T migrate node packages/database/dist/preview-maintenance.js --apply --batch-size=1 --max-batches=1 > /tmp/preview-maintenance-applied.json
jq -e '.mode=="apply" and .tables.xp_previews.deleted == 1 and .tables.competition_previews.deleted == 1 and .maximumDeletesPerTable == 1' /tmp/preview-maintenance-applied.json
test "$(docker compose exec -T db psql -U clog -d clog -Atc "SELECT count(*) FROM xp_previews WHERE token_hash=repeat('a',64)")" = "0"
test "$(docker compose exec -T db psql -U clog -d clog -Atc "SELECT count(*) FROM competition_previews WHERE token_hash=repeat('b',64)")" = "0"
docker compose exec -T app node --input-type=module -e "
  import pg from 'pg';
  const c = new pg.Client({connectionString:process.env.DATABASE_URL});
  await c.connect();
  try {
    const p = (await c.query(\"SELECT has_table_privilege(current_user,'xp_previews','SELECT') AS xs,has_table_privilege(current_user,'xp_previews','INSERT') AS xi,has_table_privilege(current_user,'xp_previews','UPDATE') AS xu,has_table_privilege(current_user,'xp_previews','DELETE') AS xd,has_table_privilege(current_user,'competition_previews','SELECT') AS cs,has_table_privilege(current_user,'competition_previews','INSERT') AS ci,has_table_privilege(current_user,'competition_previews','UPDATE') AS cu,has_table_privilege(current_user,'competition_previews','DELETE') AS cd,has_table_privilege(current_user,'xp_import_history','DELETE') AS hd,has_table_privilege(current_user,'competition_import_history','DELETE') AS ch\")).rows[0];
    if (JSON.stringify(p)!==JSON.stringify({xs:true,xi:true,xu:true,xd:false,cs:true,ci:true,cu:true,cd:false,hd:false,ch:false})) throw Error('Unexpected runtime maintenance privileges');
  } finally { await c.end(); }
"

printf "\nAdmin catalog, durable icons and coordinated backup\n"
docker compose exec -T -e CATALOG_SMOKE_TEST=1 app node --input-type=module < scripts/catalog-smoke.mjs > /tmp/catalog-created.json
icon_path="$(jq -r '.iconPath' /tmp/catalog-created.json)"
curl --fail "http://app:8080$icon_path" --output /tmp/icon-before.png
docker compose up -d --no-deps --force-recreate --wait app
curl --fail --retry 5 --retry-delay 1 --retry-connrefused "http://app:8080$icon_path" --output /tmp/icon-after.png
cmp /tmp/icon-before.png /tmp/icon-after.png
curl --fail --output /tmp/catalog-after.json http://app:8080/api/v1/catalog
jq -e --slurpfile receipt /tmp/catalog-created.json '
  ([.pages[] | select(.category=="bosses")][0].id == $receipt[0].pageId) and
  ([.pages[] | select(.id==$receipt[0].pageId) | .itemIds] == [[$receipt[0].itemId]]) and
  ([.pages[] | select(.id==$receipt[0].deletedPageId)] | length == 0)
' /tmp/catalog-after.json
bash infra/backup.sh /tmp/catalog-backup
test -f /tmp/catalog-backup/COMPLETE
(cd /tmp/catalog-backup && sha256sum --check SHA256SUMS)
tar -tzf /tmp/catalog-backup/icons.tar.gz | grep "$(basename "$icon_path")"
tar -tzf /tmp/catalog-backup/screenshots.tar.gz | grep -Fx './.clan-api-key.secret'

printf "\nRestart PostgreSQL and verify API recovers without a process restart\n"
app_id="$(docker compose ps -q app)"
app_started="$(docker inspect --format '{{.State.StartedAt}}' "$app_id")"
curl --fail --retry 15 --retry-delay 1 --retry-all-errors --retry-connrefused http://app:8080/readyz
docker compose stop db
test "$(curl -sS -o /dev/null -w '%{http_code}' http://app:8080/healthz)" = "200"
test "$(curl -sS -o /dev/null -w '%{http_code}' http://app:8080/readyz)" = "503"
docker compose start db
for _attempt in $(seq 1 30); do
  if curl --fail -sS http://app:8080/readyz; then break; fi
  sleep 1
done
curl --fail http://app:8080/readyz
test "$app_started" = "$(docker inspect --format '{{.State.StartedAt}}' "$app_id")"
