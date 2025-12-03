import * as dotenv from "dotenv";
import { resolve } from "path";

// Load test environment variables
dotenv.config({ path: resolve(__dirname, "../../.env.test") });

// Warn if environment variables are missing
if (!process.env.INSTANTDB_APP_ID || !process.env.INSTANTDB_ADMIN_TOKEN) {
  console.warn(
    "Warning: INSTANTDB_APP_ID and INSTANTDB_ADMIN_TOKEN not set. " +
      "Integration tests will fail. Create a .env.test file with these variables."
  );
}

// Cleanup is handled by globalSetup.ts teardown, which runs once after ALL tests complete.
