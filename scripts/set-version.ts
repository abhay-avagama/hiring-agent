/**
 * One command for the version that appears in four places, because three of them are easy to forget:
 * the package, the MCP registry listing, the Gemini CLI manifest, and the tag the release workflow checks.
 *
 *   bun run scripts/set-version.ts 0.1.49
 *
 * The version line is replaced in place rather than the file re-serialized: reformatting package.json on
 * every release would bury the real change in whitespace.
 */
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run scripts/set-version.ts <major.minor.patch>");
  process.exit(1);
}
for (const path of ["package.json", "server.json", "gemini-extension.json"]) {
  const before = await Bun.file(path).text();
  const after = before.replace(/"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`);
  if (after === before && !before.includes(`"version": "${version}"`)) throw new Error(`no version field in ${path}`);
  await Bun.write(path, after);
  console.log(`${path} -> ${version}`);
}
// The constant every MCP client reads back as serverInfo.version, and the one the update check compares against
// npm. It sat two releases behind and told people running the newest package that an update was available.
const versionFile = "src/version.ts";
const source = await Bun.file(versionFile).text();
const updated = source.replace(/"\d+\.\d+\.\d+"/, `"${version}"`);
if (updated === source && !source.includes(`"${version}"`)) throw new Error(`no version literal in ${versionFile}`);
await Bun.write(versionFile, updated);
console.log(`${versionFile} -> ${version}`);
console.log(`\nnext: git commit -am "release: ${version}" && git tag v${version} && git push origin main v${version}`);
