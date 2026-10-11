import { pathToFileURL } from 'node:url';

export const isRelease = (version) =>
  version.metadata.container.tags.some((tag) => /^release(?:$|-)/.test(tag));

// Keep the entire manifest graph: untagged platform/provenance manifests are
// real dependencies, not necessarily abandoned builds.
export async function planCleanup(versions, readManifest, now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const keep = new Set();
  const visit = async (digest) => {
    if (keep.has(digest)) return;
    keep.add(digest);
    const manifest = await readManifest(digest);
    for (const child of manifest.manifests ?? []) await visit(child.digest);
    if (manifest.subject) await visit(manifest.subject.digest);
  };
  for (const version of versions) {
    const created = Date.parse(version.created_at);
    const updated = Date.parse(version.updated_at);
    if (!Number.isFinite(created) || !Number.isFinite(updated))
      throw new Error(`Invalid timestamps on version ${version.id}`);
    if (isRelease(version) || Math.max(created, updated) > cutoff)
      await visit(version.name);
  }
  return versions.filter((version) => !keep.has(version.name));
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token)
    throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  const apply = process.argv.includes('--apply');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function api(path, method = 'GET') {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const repo = await api(`/repos/${repository}`);
  const owner = repo.owner.login;
  const root = `/${repo.owner.type === 'Organization' ? 'orgs' : 'users'}/${owner}/packages/container`;
  // Explicit allowlist includes the retired three-service development images.
  for (const service of ['app', 'web', 'api', 'bot']) {
    const name = `${repo.name.toLowerCase()}-${service}`;
    const base = `${root}/${encodeURIComponent(name)}`;
    const packageResponse = await fetch(`https://api.github.com${base}`, {
      headers,
    });
    if (packageResponse.status === 404) {
      console.log(`${name}: absent or inaccessible; skipped`);
      continue;
    }
    if (!packageResponse.ok)
      throw new Error(`${name}: HTTP ${packageResponse.status}`);
    const pkg = await packageResponse.json();
    if (pkg.repository?.full_name.toLowerCase() !== repository.toLowerCase())
      throw new Error(`${name}: package is not linked to ${repository}`);
    const versions = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${base}/versions?per_page=100&page=${page}`);
      versions.push(...batch);
      if (batch.length < 100) break;
    }
    const image = `${owner.toLowerCase()}/${name}`;
    const auth = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${image}:pull`)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR ?? owner}:${token}`).toString('base64')}`,
        },
      },
    );
    if (!auth.ok)
      throw new Error(`${name}: registry authentication HTTP ${auth.status}`);
    const registryToken = (await auth.json()).token;
    if (!registryToken) throw new Error(`${name}: missing registry token`);
    const readManifest = async (digest) => {
      const response = await fetch(
        `https://ghcr.io/v2/${image}/manifests/${digest}`,
        {
          headers: {
            Authorization: `Bearer ${registryToken}`,
            Accept:
              'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `${name}@${digest}: HTTP ${response.status}; refusing cleanup`,
        );
      return response.json();
    };
    const candidates = await planCleanup(versions, readManifest);
    console.log(
      `${name}: ${versions.length} versions, ${candidates.length} expired, ${versions.length - candidates.length} retained`,
    );
    for (const candidate of candidates) {
      // Fail closed if tags/timestamps changed after planning. All repository
      // publishing/promotion jobs also share the cleanup concurrency group.
      const current = await api(`${base}/versions/${candidate.id}`);
      if (
        isRelease(current) ||
        current.updated_at !== candidate.updated_at ||
        JSON.stringify(current.metadata.container.tags) !==
          JSON.stringify(candidate.metadata.container.tags)
      )
        throw new Error(
          `${name}/${candidate.id}: changed during cleanup; rerun to replan`,
        );
      console.log(
        `${apply ? 'Deleting' : 'Would delete'} ${name}/${candidate.id} ${candidate.name} tags=${JSON.stringify(candidate.metadata.container.tags)}`,
      );
      if (apply) await api(`${base}/versions/${candidate.id}`, 'DELETE');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
