import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  provisionTempInstantApp,
  pushSchema,
  pushPerms,
} from "@upfor/shared/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const syncPackageRoot = resolve(__dirname, "../..");
const schemaPath = resolve(__dirname, "../instant.schema.ts");
const permsPath = resolve(__dirname, "../instant.perms.ts");

export async function setup() {
  const app = provisionTempInstantApp("upfor-sync-test");
  console.log(`Provisioned temp test app: ${app.appId}`);
  pushSchema(app, { cwd: syncPackageRoot, schemaPath });
  pushPerms(app, { cwd: syncPackageRoot, permsPath });

  // globalSetup runs in the main vitest process before any test worker is
  // forked. Forked workers inherit process.env, so writing here makes the
  // creds visible to every test file without a hand-off file.
  process.env.INSTANTDB_APP_ID = app.appId;
  process.env.INSTANTDB_ADMIN_TOKEN = app.adminToken;
  process.env.NODE_ENV = "test";
}
