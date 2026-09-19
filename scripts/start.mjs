import { cpSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

// Next standalone output does not copy public/static assets automatically.
const projectRoot = process.cwd();
const standalone = resolve(projectRoot, ".next/standalone");
const serverPath = join(standalone, "server.js");
if (!existsSync(serverPath)) {
  console.error("Run pnpm build before pnpm start.");
  process.exit(1);
}
cpSync(join(projectRoot, "public"), join(standalone, "public"), { recursive: true });
cpSync(join(projectRoot, ".next/static"), join(standalone, ".next/static"), { recursive: true });
// server.js changes cwd. Keep a relative database outside the disposable build directory.
process.env.DATABASE_PATH = resolve(projectRoot, process.env.DATABASE_PATH || "./data/haru.db");
process.env.HOSTNAME ||= "0.0.0.0";
process.env.NODE_ENV = "production";
createRequire(import.meta.url)(serverPath);
