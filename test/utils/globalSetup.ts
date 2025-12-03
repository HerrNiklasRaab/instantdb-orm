import * as dotenv from "dotenv";
import { resolve } from "path";
import { init } from "@instantdb/admin";
import { execSync } from "child_process";

// Load test environment variables
dotenv.config({ path: resolve(__dirname, "../../.env.test") });

/**
 * Push schema to InstantDB before running tests using the CLI.
 * This ensures the remote schema matches the local schema definition.
 */
async function pushSchema() {
  if (!process.env.INSTANTDB_APP_ID || !process.env.INSTANTDB_ADMIN_TOKEN) {
    console.warn("Skipping schema push: missing INSTANTDB_APP_ID or INSTANTDB_ADMIN_TOKEN");
    return;
  }

  const schemaPath = resolve(__dirname, "../instant.schema.ts");
  const appId = process.env.INSTANTDB_APP_ID;

  try {
    // Use the CLI to push schema - the 'yes |' auto-confirms prompts
    // --skip-check-types allows destructive changes
    const result = execSync(
      `yes | npx instant-cli push schema --app ${appId} --skip-check-types`,
      {
        cwd: resolve(__dirname, "../.."),
        env: {
          ...process.env,
          INSTANT_APP_ID: appId,
          INSTANT_ADMIN_TOKEN: process.env.INSTANTDB_ADMIN_TOKEN,
          INSTANT_SCHEMA_FILE_PATH: schemaPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }
    );
    console.log("Schema push result:", result.toString().slice(0, 500));
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message: string };
    console.error("Schema push failed:", err.message);
    if (err.stdout) console.log("stdout:", err.stdout.toString());
    if (err.stderr) console.log("stderr:", err.stderr.toString());
    // Don't throw - let tests continue even if schema push fails
  }
}

export async function setup() {
  await pushSchema();
}

export async function teardown() {
  if (!process.env.INSTANTDB_APP_ID || !process.env.INSTANTDB_ADMIN_TOKEN) {
    return;
  }

  // Dynamic import to avoid issues with schema types
  const { default: schema } = await import("../instant.schema");

  const db = init({
    appId: process.env.INSTANTDB_APP_ID,
    adminToken: process.env.INSTANTDB_ADMIN_TOKEN,
    schema: schema as Parameters<typeof init>[0]["schema"],
  });

  // Query all entities
  const result = await db.query({
    users: {},
    profiles: {},
    posts: {},
  });

  const txChunks: Parameters<typeof db.transact>[0] = [];

  // Delete all users
  for (const user of (result.users ?? []) as { id: string }[]) {
    txChunks.push(db.tx.users[user.id].delete());
  }

  // Delete all profiles
  for (const profile of (result.profiles ?? []) as { id: string }[]) {
    txChunks.push(db.tx.profiles[profile.id].delete());
  }

  // Delete all posts
  for (const post of (result.posts ?? []) as { id: string }[]) {
    txChunks.push(db.tx.posts[post.id].delete());
  }

  if (txChunks.length > 0) {
    await db.transact(txChunks);
    console.log(`Cleaned up ${txChunks.length} test entities`);
  }
}
