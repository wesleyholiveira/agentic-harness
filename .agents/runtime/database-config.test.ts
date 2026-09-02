import { describe, expect, it, vi } from "vitest";
import { resolveDatabaseAppUrl } from "./database-config.mjs";

describe("agent runtime database configuration", () => {
  it("uses the canonical app URL inside containers", () => {
    const environment = {
      DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness",
      DATABASE_URL: "postgresql://app:secret@postgres/agent_harness",
    };

    expect(resolveDatabaseAppUrl(environment, { existsSync: () => true })).toBe(environment.DATABASE_APP_URL);
  });

  it("rewrites the Compose postgres service name to loopback for a host-side runtime", () => {
    const resolved = resolveDatabaseAppUrl(
      { DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness" },
      { existsSync: () => false },
    );
    expect(resolved).toBe("postgresql://app:secret@127.0.0.1:5432/agent_harness");
  });

  it("allows an explicit host-side Agent Runtime URL to differ from DATABASE_APP_URL", () => {
    const resolved = resolveDatabaseAppUrl(
      {
        DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness",
        AGENT_HARNESS_AGENT_DATABASE_URL: "postgresql://app:secret@127.0.0.1:5432/agent_harness",
      },
      { existsSync: () => false },
    );
    expect(resolved).toBe("postgresql://app:secret@127.0.0.1:5432/agent_harness");
  });

  it("reads DATABASE_APP_URL_FILE without exposing its contents in errors", () => {
    const readFileSync = vi.fn(() => "postgresql://app:file-secret@postgres/agent_harness\n");

    expect(
      resolveDatabaseAppUrl(
        { DATABASE_APP_URL_FILE: "/run/secrets/database-app-url" },
        { readFileSync, existsSync: () => true },
      ),
    ).toBe("postgresql://app:file-secret@postgres/agent_harness");
    expect(readFileSync).toHaveBeenCalledWith("/run/secrets/database-app-url", "utf8");
  });

  it("rejects a privileged or stale DATABASE_URL alias without including either URL", () => {
    expect(() =>
      resolveDatabaseAppUrl({
        DATABASE_APP_URL: "postgresql://app:app-secret@postgres/agent_harness",
        DATABASE_URL: "postgresql://admin:admin-secret@postgres/agent_harness",
      }),
    ).toThrowError("database_app_url_alias_mismatch");
  });

  it("preserves legacy Agent Runtime aliases when the canonical app URL is absent", () => {
    expect(
      resolveDatabaseAppUrl({
        AGENT_HARNESS_AGENT_DATABASE_URL: "postgresql://app:secret@127.0.0.1/agent_harness",
      }),
    ).toBe("postgresql://app:secret@127.0.0.1/agent_harness");
    expect(
      resolveDatabaseAppUrl({
        AGENT_POSTGRES_URL: "postgresql://app:secret@127.0.0.1/agent_harness",
      }),
    ).toBe("postgresql://app:secret@127.0.0.1/agent_harness");
    expect(
      resolveDatabaseAppUrl(
        { DATABASE_URL_FILE: "/run/secrets/database-url" },
        {
          readFileSync: () => "postgresql://app:secret@postgres/agent_harness",
          existsSync: () => true,
        },
      ),
    ).toBe("postgresql://app:secret@postgres/agent_harness");
  });

  it("requires the two explicit Agent Runtime aliases to agree with each other", () => {
    expect(() =>
      resolveDatabaseAppUrl({
        AGENT_HARNESS_AGENT_DATABASE_URL: "postgresql://app:secret@127.0.0.1/agent_harness",
        AGENT_POSTGRES_URL: "postgresql://app:secret@localhost/other",
      }),
    ).toThrowError("agent_database_url_alias_mismatch");
  });

  it("resolves the exact dotenv compatibility reference without treating it as a URL", () => {
    const dotenvAlias = ["$", "{DATABASE_APP_URL}"].join("");
    expect(
      resolveDatabaseAppUrl(
        {
          DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness",
          DATABASE_URL: dotenvAlias,
          AGENT_HARNESS_AGENT_DATABASE_URL: dotenvAlias,
        },
        { existsSync: () => true },
      ),
    ).toBe("postgresql://app:secret@postgres/agent_harness");
    expect(() =>
      resolveDatabaseAppUrl({
        DATABASE_URL: dotenvAlias,
      }),
    ).toThrowError("database_app_url_alias_unresolved");
  });

  it("supports an explicit network mode override", () => {
    expect(
      resolveDatabaseAppUrl(
        {
          DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness",
          AGENT_HARNESS_AGENT_DATABASE_NETWORK_MODE: "host",
        },
        { existsSync: () => true },
      ),
    ).toBe("postgresql://app:secret@127.0.0.1:5432/agent_harness");
    expect(
      resolveDatabaseAppUrl(
        {
          DATABASE_APP_URL: "postgresql://app:secret@postgres/agent_harness",
          AGENT_HARNESS_AGENT_DATABASE_NETWORK_MODE: "container",
        },
        { existsSync: () => false },
      ),
    ).toBe("postgresql://app:secret@postgres/agent_harness");
  });

  it("classifies unreadable and empty secret files without leaking paths or values", () => {
    expect(() =>
      resolveDatabaseAppUrl(
        { DATABASE_APP_URL_FILE: "/sensitive/path/database-url" },
        {
          readFileSync: () => {
            throw new Error("contains file-secret");
          },
        },
      ),
    ).toThrowError("database_app_url_file_unreadable");
    expect(() =>
      resolveDatabaseAppUrl(
        { DATABASE_APP_URL_FILE: "/sensitive/path/database-url" },
        { readFileSync: () => " \n" },
      ),
    ).toThrowError("database_app_url_file_empty");
  });
});
