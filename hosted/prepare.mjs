// Run after npm run build, against a Sites Vinext scaffold prepared by its helper.
import { copyFile, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2]);
const projectId = process.argv[3];
if (!projectId || !target || target === root) throw new Error('Pass the prepared Vinext checkout and existing Site ID.');
const write = async (name, content) => {
  await mkdir(dirname(resolve(target, name)), { recursive: true });
  await writeFile(resolve(target, name), content);
};
const manifest = JSON.parse(await readFile(resolve(target, '.openai/hosting.json'), 'utf8'));
if (manifest.project_id && manifest.project_id !== projectId) throw new Error('Site ID mismatch');
delete manifest.static;
await write('.openai/hosting.json', JSON.stringify({ ...manifest, project_id: projectId, d1: 'DB', r2: null }, null, 2) + '\n');
await copyFile(resolve(root, 'dist/index.html'), resolve(target, 'studio.html'));
for (const name of ['app.js', 'neural-worker.js', 'demo-weights.json', 'style.css', '_headers']) {
  await copyFile(resolve(root, 'dist', name), resolve(target, 'public', name));
}
const config = JSON.parse(await readFile(resolve(root, 'dist/config.json'), 'utf8'));
if (config.mode !== 'demo') throw new Error('Stage from the credential-free browser demo configuration.');
await write('public/config.json', JSON.stringify({ ...config, mode: 'hosted' }, null, 2) + '\n');
await write('hosted/api.js', await readFile(resolve(root, 'hosted/api.js')));
await write('db/schema.ts', await readFile(resolve(root, 'hosted/schema.ts')));
await unlink(resolve(target, 'app/page.tsx')).catch(error => { if (error.code !== 'ENOENT') throw error; });
await write('app/route.ts', `import studio from '../studio.html?raw';
export const dynamic = 'force-dynamic';
export function GET() {
  return new Response(studio, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  } });
}
`);
await write('app/api/[...path]/route.ts', `import { env } from 'cloudflare:workers';
import { handleApi } from '../../../hosted/api.js';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleApi(request, env.DB);
export const POST = GET;
export const DELETE = GET;
export const PUT = GET;
export const PATCH = GET;
export const OPTIONS = GET;
`);
await write('app/layout.tsx', `import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Auralis · Synesthetic Composer', description: 'Compose music, see its light, and keep your private library.' };
export default function RootLayout({children}: {children: React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
`);
console.log('Prepared hosted studio, account API and D1 schema. Generate migrations before building.');
