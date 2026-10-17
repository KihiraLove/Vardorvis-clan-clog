/** Mirror production's same-origin /api routing while the frontend runs on Vite. */
import { defineConfig } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  plugins: [
    {
      name: 'public-entry-budget',
      async generateBundle(_options, bundle) {
        const root = fileURLToPath(new URL('../../', import.meta.url));
        const chunks = Object.values(bundle).filter(
          (file) => file.type === 'chunk',
        );
        const initial = new Set<string>();
        const visit = (name: string) => {
          if (initial.has(name)) return;
          const chunk = chunks.find((file) => file.fileName === name);
          if (!chunk)
            throw new Error('Missing static entry dependency: ' + name);
          initial.add(name);
          chunk.imports.forEach(visit);
        };
        chunks
          .filter((chunk) => chunk.isEntry)
          .forEach((chunk) => visit(chunk.fileName));
        const files = chunks.map((chunk) => ({
          file: chunk.fileName,
          initial: initial.has(chunk.fileName),
          bytes: Buffer.byteLength(chunk.code),
          gzipBytes: gzipSync(chunk.code).length,
          modules: Object.keys(chunk.modules)
            .filter((name) => name.includes('/apps/web/src/'))
            .map((name) => path.relative(root, name).replaceAll('\\', '/'))
            .sort(),
        }));
        if (
          chunks.some((chunk) =>
            Object.keys(chunk.modules).some(
              (name) =>
                name.includes('/apps/web/tests/') ||
                name.includes('/apps/web/tests-'),
            ),
          )
        )
          throw new Error(
            'Test fixtures must never enter a production bundle.',
          );
        const publicFiles = files.filter((file) => file.initial);
        const bytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
        const gzipBytes = publicFiles.reduce(
          (sum, file) => sum + file.gzipBytes,
          0,
        );
        const forbidden =
          /apps\/web\/src\/(?:admin-entry\.|Admin[^/]*\.|AccountSettings\.|ClanApiKeySettings\.|RuneLiteReviewSettings\.|XpAdmin\.|CompetitionImport\.)/u;
        if (
          publicFiles.some((file) =>
            file.modules.some((module) => forbidden.test(module)),
          )
        )
          throw new Error('Staff screen entered the initial public graph.');
        if (bytes > 320000 || gzipBytes > 100000)
          throw new Error(
            'Initial public JavaScript exceeds 320,000 raw / 100,000 gzip bytes.',
          );
        await mkdir(path.join(root, '.data/local-checks'), { recursive: true });
        await writeFile(
          path.join(root, '.data/local-checks/web-bundle.json'),
          JSON.stringify(
            {
              format: 1,
              publicBytes: bytes,
              publicGzipBytes: gzipBytes,
              budget: { bytes: 320000, gzipBytes: 100000 },
              files,
            },
            null,
            2,
          ) + '\n',
        );
      },
    },
  ],
});
