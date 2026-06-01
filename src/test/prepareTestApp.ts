import { env } from "@upfor/shared/env";
import {
  TestAppProvisioner,
  type AppCacheRequest,
  type TempInstantApp,
} from "./tempInstantApp";

export async function prepareTestApp(req: AppCacheRequest): Promise<TempInstantApp> {
  const app = await TestAppProvisioner.fromRequest(req).getCleanApp();
  env.set("INSTANTDB_APP_ID", app.appId);
  env.set("INSTANTDB_ADMIN_TOKEN", app.adminToken);
  return app;
}
