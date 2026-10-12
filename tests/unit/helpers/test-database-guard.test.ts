import { describe, expect, it } from "vitest";
import { assertTestDatabaseName, databaseNameOf } from "../../helpers/test-database-guard.js";

describe("test database guard", () => {
  it.each(["usage_metering_test", "app_test", "a_test"])("accepts %s", (name) => {
    expect(() => {
      assertTestDatabaseName(name);
    }).not.toThrow();
  });

  it.each(["usage_metering", "postgres", "test", "usage_metering_test_backup", "App_test", ""])(
    "refuses %j",
    (name) => {
      expect(() => {
        assertTestDatabaseName(name);
      }).toThrow("Refusing to use database");
    },
  );

  it("reads the database name from a URL", () => {
    expect(databaseNameOf("postgres://u:p@localhost:5432/usage_metering_test")).toBe(
      "usage_metering_test",
    );
  });
});
