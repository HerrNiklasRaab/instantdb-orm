import {
  getOrProvisionApp,
  wipeAppData,
  type AppCacheRequest,
  type ProvisionedApp,
} from "./tempInstantApp";

/**
 * Provision (or reuse) a cached temp InstantDB app, wipe data on reuse, and
 * plant the env vars the admin SDK + any in-process service need to find it.
 * Callers add their own service-specific env on top.
 */
export async function prepareTestApp(req: AppCacheRequest): Promise<ProvisionedApp> {
  const app = await getOrProvisionApp(req);
  if (app.reused) await wipeAppData({ app, schema: req.schema });
  Object.assign(process.env, {
    INSTANTDB_APP_ID: app.appId,
    INSTANTDB_ADMIN_TOKEN: app.adminToken,
    NODE_ENV: "test",
  });
  return app;
}
