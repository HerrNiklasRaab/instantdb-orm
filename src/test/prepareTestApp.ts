import {
  TestAppProvisioner,
  type AppCacheRequest,
  type TempInstantApp,
} from "./tempInstantApp";

/**
 * The app id is also planted under the bundler-public prefixes because
 * `app/lib/env.ts` and `web/lib/env.ts` resolve it exclusively through those
 * aliases and never fall back to the bare name. The admin token stays unaliased
 * — a bundler-public copy would ship it to clients.
 */
export async function prepareTestApp(req: AppCacheRequest): Promise<TempInstantApp> {
  const app = await TestAppProvisioner.fromRequest(req).getCleanApp();
  process.env.INSTANTDB_APP_ID = app.appId;
  process.env.INSTANTDB_ADMIN_TOKEN = app.adminToken;
  process.env.EXPO_PUBLIC_INSTANTDB_APP_ID = app.appId;
  process.env.NEXT_PUBLIC_INSTANTDB_APP_ID = app.appId;
  return app;
}
