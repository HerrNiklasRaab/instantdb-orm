import * as fs from "fs";
import { resolve } from "path";
import { init } from "@instantdb/admin";
import { execSync } from "child_process";
import { TEST_INSTANTDB_APP_ID, TEST_INSTANTDB_ADMIN_TOKEN } from "./instantdb-test-utils";

/**
 * Push schema to InstantDB before running tests using the CLI.
 * This ensures the remote schema matches the local schema definition.
 */
async function pushSchema() {
  const schemaPath = resolve(__dirname, "../instant.schema.ts");

  try {
    // Use the CLI to push schema
    // -y auto-confirms prompts, --skip-check-types allows destructive changes
    const result = execSync(
      `npx instant-cli push schema --app ${TEST_INSTANTDB_APP_ID} --skip-check-types -y`,
      {
        cwd: resolve(__dirname, "../.."),
        env: {
          ...process.env,
          INSTANT_APP_ID: TEST_INSTANTDB_APP_ID,
          INSTANT_ADMIN_TOKEN: TEST_INSTANTDB_ADMIN_TOKEN,
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

/**
 * Push permissions to InstantDB before running tests using the CLI.
 * This ensures the remote permissions match the local permissions definition.
 */
async function pushPerms() {
  const permsPath = resolve(__dirname, "../instant.perms.ts");

  // The instant-cli ignores INSTANT_PERMS_FILE_PATH and only looks in package root
  // So we copy the test perms file to the root, push, then clean up
  const rootPermsPath = resolve(__dirname, "../../instant.perms.ts");

  try {
    // Copy test perms to package root
    fs.copyFileSync(permsPath, rootPermsPath);
    console.log("Pushing perms from:", permsPath);

    const result = execSync(
      `npx instant-cli push perms --app ${TEST_INSTANTDB_APP_ID} -y`,
      {
        cwd: resolve(__dirname, "../.."),
        env: {
          ...process.env,
          INSTANT_APP_ID: TEST_INSTANTDB_APP_ID,
          INSTANT_ADMIN_TOKEN: TEST_INSTANTDB_ADMIN_TOKEN,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }
    );
    console.log("Perms push result:", result.toString());
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message: string };
    console.error("Perms push failed:", err.message);
    if (err.stdout) console.log("stdout:", err.stdout.toString());
    if (err.stderr) console.log("stderr:", err.stderr.toString());
    // Don't throw - let tests continue even if perms push fails
  } finally {
    // Clean up the copied file
    try {
      fs.unlinkSync(rootPermsPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function setup() {
  await pushSchema();
  await pushPerms();
}

export async function teardown() {
  // Dynamic import to avoid issues with schema types
  const { default: schema } = await import("../instant.schema");

  const db = init({
    appId: TEST_INSTANTDB_APP_ID,
    adminToken: TEST_INSTANTDB_ADMIN_TOKEN,
    schema: schema as Parameters<typeof init>[0]["schema"],
  });

  // Query all entities
  const result = await db.query({
    users: {},
    profiles: {},
    posts: {},
    invitations: {},
    chessMatchs: {},
    skiMatchs: {},
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

  // Delete all invitations (STI)
  for (const invitation of (result.invitations ?? []) as { id: string }[]) {
    txChunks.push(db.tx.invitations[invitation.id].delete());
  }

  // Delete all chessMatchs (MTI)
  for (const match of (result.chessMatchs ?? []) as { id: string }[]) {
    txChunks.push(db.tx.chessMatchs[match.id].delete());
  }

  // Delete all skiMatchs (MTI)
  for (const match of (result.skiMatchs ?? []) as { id: string }[]) {
    txChunks.push(db.tx.skiMatchs[match.id].delete());
  }

  if (txChunks.length > 0) {
    await db.transact(txChunks);
    console.log(`Cleaned up ${txChunks.length} test entities`);
  }
}
