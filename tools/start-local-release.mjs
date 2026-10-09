import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const nx = require.resolve("nx/bin/nx.js");
const localLan = process.env.LOCAL_LAN === "true";
const localLanDev = localLan && process.env.LOCAL_LAN_DEV === "true";
const localLanIp = process.env.LOCAL_LAN_IP || "";

function isPrivateIpv4(value) {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return false;

  const [first, second] = parts.map(Number);
  return (
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)) &&
    parts.every((part) => String(Number(part)) === part)
  );
}

if (localLan && !isPrivateIpv4(localLanIp)) {
  console.error("LOCAL_LAN_IP must be a private RFC1918 IPv4 address.");
  process.exitCode = 1;
  process.exit();
}

const env = {
  ...process.env,
  HOSTED: "false",
  NEXT_PUBLIC_HOSTED: "false",
  NEXT_PUBLIC_LOCAL_LAN: String(localLan),
  NEXT_PUBLIC_API_URL: "http://localhost:3001",
  LOCAL_LAN: String(localLan),
  LOCAL_LAN_IP: localLan ? localLanIp : "",
  LOCAL_LAN_DEV: String(localLanDev),
  PORT: "3001",
};

let api;
let web;
let webSnapshot;
let stopping = false;

async function snapshotWebBuild() {
  const source = resolve(root, "dist/apps/web");
  const sourceNext = resolve(source, ".next");
  const buildIdPath = resolve(sourceNext, "BUILD_ID");
  const manifestPath = resolve(sourceNext, "build-manifest.json");
  const buildId = (await readFile(buildIdPath, "utf8")).trim();
  const manifestSource = await readFile(manifestPath, "utf8");

  webSnapshot = await mkdtemp(resolve(root, "dist/apps/.local-release-web-"));
  await cp(source, webSnapshot, { recursive: true });

  const currentBuildId = (await readFile(buildIdPath, "utf8")).trim();
  const currentManifest = await readFile(manifestPath, "utf8");
  if (currentBuildId !== buildId || currentManifest !== manifestSource)
    throw new Error("Web build changed while making release snapshot.");

  const manifest = JSON.parse(
    await readFile(resolve(webSnapshot, ".next/build-manifest.json"), "utf8"),
  );
  const assets = [
    ...(manifest.polyfillFiles ?? []),
    ...(manifest.devFiles ?? []),
    ...(manifest.ampDevFiles ?? []),
    ...(manifest.lowPriorityFiles ?? []),
    ...Object.values(manifest.pages ?? {}).flat(),
  ];
  for (const asset of new Set(assets)) {
    await stat(resolve(webSnapshot, ".next", asset));
  }
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;

  const children = [web, api].filter(Boolean);
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;

      const closed = once(child, "close");
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 5000);
      forceKill.unref();
      await closed;
      clearTimeout(forceKill);
    }),
  );

  if (webSnapshot) await rm(webSnapshot, { recursive: true, force: true });

  process.exitCode = exitCode;
}

function fail() {
  void stop(1);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

api = localLanDev
  ? spawn(process.execPath, [nx, "run", "api:serve"], {
      cwd: root,
      env,
      stdio: "inherit",
    })
  : spawn(process.execPath, [resolve(root, "dist/apps/api/main.cjs")], {
      cwd: root,
      env,
      stdio: "inherit",
    });
api.on("error", fail);
api.on("close", (code) => {
  if (!stopping) void stop(code || 1);
});

async function start() {
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (stopping) return;
      if (api.exitCode !== null || api.signalCode !== null)
        throw new Error("API exited before its health check passed.");

      try {
        const response = await fetch("http://127.0.0.1:3001/healthz");
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // API may still be starting.
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }

    if (!healthy) throw new Error("API health check timed out.");
    if (stopping) return;

    if (localLanDev) {
      web = spawn(
        process.execPath,
        [nx, "run", "web:serve:development", "--hostname=0.0.0.0"],
        { cwd: root, env, stdio: "inherit" },
      );
    } else {
      await snapshotWebBuild();
      if (stopping) return;
      const next = require.resolve("next/dist/bin/next");
      const args = [next, "start", webSnapshot, "--port=3000"];
      if (localLan) args.push("--hostname=0.0.0.0");
      web = spawn(process.execPath, args, {
        cwd: root,
        env: { ...env, PORT: "3000" },
        stdio: "inherit",
      });
    }
    web.on("error", fail);
    web.on("close", () => {
      if (!stopping) fail();
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await stop(1);
  }
}

void start();
