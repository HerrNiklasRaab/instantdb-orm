import { describe, expect, it } from "vitest";
import { SyncSchema } from "../../src/schema/SyncSchema";
import { schema as client } from "../support/zenstack/client/schema";
import { schema as server } from "../support/zenstack/server/schema";

describe("the server and client schemas", () => {
  it("describe the same entities", () => {
    expect(SyncSchema.of(client).models).toEqual(SyncSchema.of(server).models);
  });

  it("share the log and keep each side's own tables to itself", () => {
    expect(Object.keys(client.models)).toContain("transactions");
    expect(Object.keys(server.models)).toContain("transactions");
    expect(Object.keys(client.models)).toContain("hiddenFields");
    expect(Object.keys(client.models)).toContain("bucketCursors");
    expect(Object.keys(server.models)).not.toContain("hiddenFields");
    expect(Object.keys(server.models)).not.toContain("bucketCursors");
    expect(Object.keys(server.models)).toContain("bucketLog");
    expect(Object.keys(client.models)).not.toContain("bucketLog");
  });

  it("target each side's database", () => {
    expect(server.provider.type).toBe("postgresql");
    expect(client.provider.type).toBe("sqlite");
  });
});
