import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { prepareTestApp } from "@upfor/shared/test";
import schema from "../../support/instant.schema";
import perms from "../../support/instant.perms";

const __dirname = dirname(fileURLToPath(import.meta.url));
const syncPackageRoot = resolve(__dirname, "../../..");
const schemaPath = resolve(__dirname, "../../support/instant.schema.ts");
const permsPath = resolve(__dirname, "../../support/instant.perms.ts");
const cacheFile = resolve(syncPackageRoot, "node_modules/.cache/upfor-sync-test-app.json");

export async function setup() {
  await prepareTestApp({
    cacheFile,
    titlePrefix: "upfor-sync-test",
    schemaPath,
    permsPath,
    schema,
    perms,
  });
}
