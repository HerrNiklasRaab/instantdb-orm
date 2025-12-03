import * as dotenv from "dotenv";
import { resolve } from "path";
import { init } from "@instantdb/admin";

// Load test environment variables
dotenv.config({ path: resolve(__dirname, "../../.env.test") });

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
    accounts: {},
    sessions: {},
    verifications: {},
  });

  const txChunks: Parameters<typeof db.transact>[0] = [];

  // Delete all users
  for (const user of (result.users ?? []) as { id: string }[]) {
    txChunks.push(db.tx.users[user.id].delete());
  }

  // Delete all accounts
  for (const account of (result.accounts ?? []) as { id: string }[]) {
    txChunks.push(db.tx.accounts[account.id].delete());
  }

  // Delete all sessions
  for (const session of (result.sessions ?? []) as { id: string }[]) {
    txChunks.push(db.tx.sessions[session.id].delete());
  }

  // Delete all verifications
  for (const verification of (result.verifications ?? []) as { id: string }[]) {
    txChunks.push(db.tx.verifications[verification.id].delete());
  }

  if (txChunks.length > 0) {
    await db.transact(txChunks);
    console.log(`Cleaned up ${txChunks.length} test entities`);
  }
}
