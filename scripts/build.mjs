import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { publicConfigSchema } from "../web/public-config.js";
const configFile = process.argv[2] || "web/config.json";
const outdir = process.argv[3] || "dist";
const config = publicConfigSchema.parse(JSON.parse(await readFile(configFile, "utf8")));
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ["web/app.js", "web/neural-worker.js"],
  bundle: true,
  minify: true,
  format: "esm",
  outdir,
  target: "es2022",
});
for (const name of [
  "index.html",
  "style.css",
  "_headers",
  "demo-weights.json",
])
  await copyFile(`web/${name}`, `${outdir}/${name}`);
await writeFile(`${outdir}/config.json`, JSON.stringify(config, null, 2));
if (config.mode === "production") {
  if (
    !/^https:\/\/[a-z0-9.-]+(?::443)?$/.test(config.apiBaseUrl) ||
    !/^[a-z0-9.-]+$/.test(config.auth0Domain) ||
    !config.auth0Domain.includes(".")
  )
    throw new Error(
      "Production API and identity origins must be explicit HTTPS origins.",
    );
  const authOrigin = `https://${config.auth0Domain}`;
  let headers = await readFile("web/_headers", "utf8");
  headers = headers
    .replace(
      "connect-src 'self';",
      `connect-src 'self' ${config.apiBaseUrl} ${authOrigin};`,
    )
    .replace(
      "frame-src https://challenges.cloudflare.com;",
      `frame-src https://challenges.cloudflare.com ${authOrigin};`,
    );
  await writeFile(`${outdir}/_headers`, headers);
}
console.log(`Built Auralis into ${outdir}/`);
