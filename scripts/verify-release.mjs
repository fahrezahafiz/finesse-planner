#!/usr/bin/env node
// Release-safety gate for the mindful expense planner. Exits non-zero on any failure so it is safe
// to wire into CI or run by hand as `npm run verify-release` immediately before a real deployment.
// It never touches the production Google Sheets workbook itself: everything here is local
// (typecheck/tests/build, a manifest file check, a local git diff, and a local checklist file).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DIST_APPSSCRIPT = "dist/appsscript.json";
const CHECKLIST_PATH = "release/deployment-checklist.json";
const CHECKLIST_TEMPLATE_PATH = "docs/runbooks/deployment-checklist.example.json";

const REQUIRED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
];

const REQUIRED_CHECKLIST_ITEMS = [
  "Development copy tested",
  "Production sharing restricted",
  "Two intended accounts verified",
  "Unauthorized account denied",
  "Smoke test complete",
];

class ReleaseGateFailure extends Error {}

function banner(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new ReleaseGateFailure(`command failed: ${command} ${args.join(" ")}`);
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** Step 1: typecheck, unit/integration tests, and build. */
function runVerificationAndBuild() {
  banner("Step 1/5: typecheck");
  run("npm", ["run", "typecheck"]);

  banner("Step 1/5: unit + integration tests");
  run("npm", ["test"]);

  banner("Step 1/5: build");
  run("npm", ["run", "build"]);
}

function readManifest() {
  if (!existsSync(DIST_APPSSCRIPT)) {
    throw new ReleaseGateFailure(`${DIST_APPSSCRIPT} does not exist. The build step should have produced it.`);
  }
  try {
    return JSON.parse(readFileSync(DIST_APPSSCRIPT, "utf8"));
  } catch (error) {
    throw new ReleaseGateFailure(`${DIST_APPSSCRIPT} is not valid JSON: ${error.message}`);
  }
}

/**
 * Step 2: reject any access other than ANYONE or executeAs other than USER_ACCESSING.
 * Step 3: confirm the advanced Sheets service and only the two required OAuth scopes.
 * The spec (section 12, "Access and security") requires the app be deployed for signed-in Google
 * users only and execute as the accessing user, never the deploying owner: ANYONE_ANONYMOUS or
 * DOMAIN would broaden access beyond signed-in Google users, and USER_DEPLOYING would run every
 * request as the developer instead of the caller, defeating the workbook-permission authorization
 * model entirely.
 */
function checkManifest(manifest) {
  banner("Step 2-3/5: dist/appsscript.json manifest safety");
  const errors = [];

  const access = manifest.webapp?.access;
  if (access !== "ANYONE") {
    errors.push(`webapp.access must be exactly "ANYONE" (signed-in Google users only); found ${JSON.stringify(access)}.`);
  }

  const executeAs = manifest.webapp?.executeAs;
  if (executeAs !== "USER_ACCESSING") {
    errors.push(`webapp.executeAs must be exactly "USER_ACCESSING"; found ${JSON.stringify(executeAs)}.`);
  }

  const advancedServices = manifest.dependencies?.enabledAdvancedServices ?? [];
  const sheetsService = advancedServices.find(service => service?.serviceId === "sheets");
  if (!sheetsService || sheetsService.userSymbol !== "Sheets" || sheetsService.version !== "v4") {
    errors.push('the "Sheets" v4 advanced service must be enabled under dependencies.enabledAdvancedServices.');
  }

  const scopes = Array.isArray(manifest.oauthScopes) ? manifest.oauthScopes : [];
  const missingScopes = REQUIRED_OAUTH_SCOPES.filter(scope => !scopes.includes(scope));
  const extraScopes = scopes.filter(scope => !REQUIRED_OAUTH_SCOPES.includes(scope));
  if (missingScopes.length) errors.push(`missing required OAuth scope(s): ${missingScopes.join(", ")}`);
  if (extraScopes.length) errors.push(`unexpected extra OAuth scope(s) present: ${extraScopes.join(", ")}`);

  if (errors.length) {
    throw new ReleaseGateFailure(`Manifest is not safe to deploy:\n${errors.map(message => `  - ${message}`).join("\n")}`);
  }
  process.stdout.write("Manifest is safe: ANYONE / USER_ACCESSING, Sheets v4 enabled, exactly the two required OAuth scopes.\n");
}

/**
 * Step 4: confirm the build is reproducible. dist/ is gitignored (it is generated output, never
 * committed), so this uses `git add -f` purely as a local diffing tool: it stages one build's
 * output, rebuilds, and diffs the working tree against that staged snapshot. Any difference means
 * the build is not deterministic and must not be trusted to reproduce what was verified above.
 * The staged snapshot is always unstaged again afterward; nothing about this step commits anything.
 */
function checkReproducibleBuild() {
  banner("Step 4/5: build reproducibility (git diff --exit-code on dist/)");
  git(["add", "-f", "--", "dist"]);
  try {
    run("npm", ["run", "build"]);
    const diff = spawnSync("git", ["diff", "--exit-code", "--", "dist"], { stdio: "inherit" });
    if (diff.status !== 0) {
      throw new ReleaseGateFailure("dist/ differs between two consecutive builds from the same source: the build is not reproducible.");
    }
    process.stdout.write("Two consecutive builds produced byte-identical dist/ output.\n");
  } finally {
    // Always unstage: this check must never leave dist staged for a commit.
    spawnSync("git", ["reset", "--", "dist"], { stdio: "inherit" });
  }
}

/**
 * Step 5: require a checked deployment checklist. release/deployment-checklist.json is
 * intentionally gitignored (see docs/runbooks/deploy.md): it is a per-release, operator-maintained
 * attestation, not a fact that belongs in source control, and a fresh checkout with no completed
 * release correctly has none. A missing file, an incomplete item, or a malformed value all fail
 * closed the same way the rest of this application does for missing/invalid workbook state.
 */
function checkDeploymentChecklist() {
  banner("Step 5/5: deployment checklist");
  if (!existsSync(CHECKLIST_PATH)) {
    throw new ReleaseGateFailure(
      `No deployment checklist found at ${CHECKLIST_PATH}.\n` +
      `Copy ${CHECKLIST_TEMPLATE_PATH} to ${CHECKLIST_PATH} and complete it truthfully after finishing the ` +
      "steps in docs/runbooks/deploy.md and docs/runbooks/smoke-test.md before releasing.",
    );
  }

  let checklist;
  try {
    checklist = JSON.parse(readFileSync(CHECKLIST_PATH, "utf8"));
  } catch (error) {
    throw new ReleaseGateFailure(`${CHECKLIST_PATH} is not valid JSON: ${error.message}`);
  }
  if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) {
    throw new ReleaseGateFailure(`${CHECKLIST_PATH} must contain a JSON object.`);
  }

  const incomplete = REQUIRED_CHECKLIST_ITEMS.filter(item => checklist[item] !== true);
  if (incomplete.length) {
    throw new ReleaseGateFailure(
      `Deployment checklist at ${CHECKLIST_PATH} is incomplete. These items are not checked true:\n` +
      incomplete.map(item => `  - ${item}`).join("\n"),
    );
  }
  process.stdout.write("Deployment checklist is present and every required item is checked true.\n");
}

function main() {
  try {
    runVerificationAndBuild();
    const manifest = readManifest();
    checkManifest(manifest);
    checkReproducibleBuild();
    checkDeploymentChecklist();
  } catch (error) {
    if (error instanceof ReleaseGateFailure) {
      process.stderr.write(`\nRELEASE GATE FAILED: ${error.message}\n`);
    } else {
      process.stderr.write(`\nRELEASE GATE FAILED with an unexpected error: ${error.stack ?? error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nAll release-gate checks passed.\n");
}

main();
