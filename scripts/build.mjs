import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const distDirectory = "dist";

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

const [serverBundle, clientBundle, index, styles] = await Promise.all([
  build({
    entryPoints: ["src/server/main.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  }),
  build({
    entryPoints: ["src/client/client.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  }),
  readFile("src/client/index.html", "utf8"),
  readFile("src/client/styles.css", "utf8"),
]);

await Promise.all([
  writeFile(`${distDirectory}/Code.js`, serverBundle.outputFiles[0].text),
  writeFile(`${distDirectory}/Client.html`, `<script>\n${clientBundle.outputFiles[0].text}</script>\n`),
  writeFile(`${distDirectory}/Index.html`, index),
  writeFile(`${distDirectory}/Styles.html`, `<style>\n${styles}</style>\n`),
  cp("src/appsscript.json", `${distDirectory}/appsscript.json`),
]);
