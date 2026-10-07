import { createRequire } from "module";
import { isAbsolute, resolve } from "path";
import { AuthService } from "./auth.service";

const nodeRequire = createRequire(`${process.cwd()}/package.json`);
const fs = nodeRequire("fs") as typeof import("fs");

function refuse(message: string): never {
  throw new Error(message);
}
let pending = Buffer.alloc(0);
async function readLine(): Promise<string> {
  while (true) {
    const newline = pending.indexOf(10);
    if (newline >= 0) {
      const line = pending
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      pending = pending.subarray(newline + 1);
      return line;
    }
    const chunk = await new Promise<Buffer>((resolveChunk, reject) => {
      const onData = (data: Buffer) => {
        process.stdin.removeListener("error", onError);
        resolveChunk(Buffer.from(data));
      };
      const onError = (error: Error) => {
        process.stdin.removeListener("data", onData);
        reject(error);
      };
      process.stdin.once("data", onData);
      process.stdin.once("error", onError);
      process.stdin.resume();
    });
    pending = Buffer.concat([pending, chunk]);
  }
}
async function ask(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return readLine();
}
async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stderr.write("Admin password (via stdin; min 12 characters): ");
    return readLine();
  }
  process.stderr.write("Admin password (input hidden; min 12 characters): ");
  const chunks: Buffer[] = [];
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  return new Promise((resolveSecret, reject) => {
    const finish = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish();
          reject(new Error("Password input cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          resolveSecret(Buffer.concat(chunks).toString("utf8"));
          return;
        }
        if (byte === 127 || byte === 8) chunks.pop();
        else chunks.push(Buffer.from([byte]));
      }
    };
    process.stdin.on("data", onData);
  });
}
async function main(): Promise<void> {
  if (process.env.HOSTED !== "true")
    refuse("Refusing: HOSTED must equal true.");
  if (process.argv.length !== 3 || process.argv[2].startsWith("-"))
    refuse(
      "Usage: npm run bootstrap:admin -- <username>; provide password on stdin.",
    );
  const databasePath = process.env.RELATIONSHIP_DB;
  if (!databasePath || !isAbsolute(databasePath))
    refuse("Refusing: RELATIONSHIP_DB must be an explicit absolute file path.");
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile())
    refuse(
      "Refusing: configured database file does not exist or is not a file.",
    );
  const realPath = fs.realpathSync(databasePath);
  if (
    (await ask(
      `Database path: ${realPath}\nType this exact path to continue: `,
    )) !== realPath
  )
    refuse("Path confirmation did not match; no database opened.");
  if (resolve(databasePath) !== resolve(process.env.RELATIONSHIP_DB))
    refuse("Configured database path changed; refusing.");
  const password = await readSecret();
  let auth: AuthService | undefined;
  try {
    auth = new AuthService();
    const user = await auth.bootstrapAdmin(process.argv[2], password);
    process.stdout.write(`Initial admin created: ${user.username}\n`);
  } finally {
    auth?.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Bootstrap failed."}\n`,
  );
  process.exitCode = 1;
});
