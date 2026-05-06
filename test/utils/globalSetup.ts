import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getOrProvisionApp, wipeAppData } from "@upfor/shared/test";
import schema from "../instant.schema";
import perms from "../instant.perms";

const __dirname = dirname(fileURLToPath(import.meta.url));
const syncPackageRoot = resolve(__dirname, "../..");
const schemaPath = resolve(__dirname, "../instant.schema.ts");
const permsPath = resolve(__dirname, "../instant.perms.ts");
const cacheFile = resolve(syncPackageRoot, "node_modules/.cache/upfor-sync-test-app.json");

export async function setup() {
  const app = await getOrProvisionApp({
    cacheFile,
    titlePrefix: "upfor-sync-test",
    schemaPath,
    permsPath,
    schema,
    perms,
  });

  if (app.reused) {
    // Wipes every non-system entity in the test schema. Adding a new test
    // entity doesn't require updating this call site.
    await wipeAppData({ app, schema });
  }

  process.env.INSTANTDB_APP_ID = app.appId;
  process.env.INSTANTDB_ADMIN_TOKEN = app.adminToken;
  process.env.NODE_ENV = "test";
}
