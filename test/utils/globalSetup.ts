import * as fs from "fs";
import { resolve } from "path";
import { init } from "@instantdb/admin";
import { execSync } from "child_process";
import { TEST_INSTANTDB_APP_ID, TEST_INSTANTDB_ADMIN_TOKEN } from "./instantdb-test-utils";

// Curated env for instant-cli child processes.
// Inherits only PATH/HOME (needed by bunx) and forces the test app credentials.
// Ambient INSTANT_* from the user's shell is intentionally NOT propagated, so
// tests can never accidentally push to the wrong app.
function cliEnv(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    INSTANT_APP_ID: TEST_INSTANTDB_APP_ID,
    INSTANT_ADMIN_TOKEN: TEST_INSTANTDB_ADMIN_TOKEN,
    ...extras,
  };
}

async function pushSchema() {
  // bunx is required: npx is wedged on @effect/* peer deps for instant-cli.
  // -y auto-confirms prompts, --skip-check-types allows destructive changes.
  const result = execSync(
    `bunx instant-cli@latest push schema --app ${TEST_INSTANTDB_APP_ID} --skip-check-types -y`,
    {
      cwd: resolve(__dirname, "../.."),
      env: cliEnv({ INSTANT_SCHEMA_FILE_PATH: resolve(__dirname, "../instant.schema.ts") }),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    }
  );
  console.log("Schema push result:", result.toString().slice(0, 500));
}

async function pushPerms() {
  // instant-cli ignores INSTANT_PERMS_FILE_PATH and only looks in package root,
  // so copy the test perms file there for the duration of the push.
  const permsPath = resolve(__dirname, "../instant.perms.ts");
  const rootPermsPath = resolve(__dirname, "../../instant.perms.ts");

  fs.copyFileSync(permsPath, rootPermsPath);
  try {
    const result = execSync(
      `bunx instant-cli@latest push perms --app ${TEST_INSTANTDB_APP_ID} -y`,
      {
        cwd: resolve(__dirname, "../.."),
        env: cliEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }
    );
    console.log("Perms push result:", result.toString());
  } finally {
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
  const { default: schema } = await import("../instant.schema");

  const db = init({
    appId: TEST_INSTANTDB_APP_ID,
    adminToken: TEST_INSTANTDB_ADMIN_TOKEN,
    schema: schema as Parameters<typeof init>[0]["schema"],
  });

  const result = await db.query({
    users: {},
    profiles: {},
    posts: {},
    invitations: {},
    chessMatchs: {},
    skiMatchs: {},
  });

  const txChunks: Parameters<typeof db.transact>[0] = [];

  for (const user of (result.users ?? []) as { id: string }[]) {
    txChunks.push(db.tx.users[user.id].delete());
  }
  for (const profile of (result.profiles ?? []) as { id: string }[]) {
    txChunks.push(db.tx.profiles[profile.id].delete());
  }
  for (const post of (result.posts ?? []) as { id: string }[]) {
    txChunks.push(db.tx.posts[post.id].delete());
  }
  for (const invitation of (result.invitations ?? []) as { id: string }[]) {
    txChunks.push(db.tx.invitations[invitation.id].delete());
  }
  for (const match of (result.chessMatchs ?? []) as { id: string }[]) {
    txChunks.push(db.tx.chessMatchs[match.id].delete());
  }
  for (const match of (result.skiMatchs ?? []) as { id: string }[]) {
    txChunks.push(db.tx.skiMatchs[match.id].delete());
  }

  if (txChunks.length > 0) {
    await db.transact(txChunks);
    console.log(`Cleaned up ${txChunks.length} test entities`);
  }
}
