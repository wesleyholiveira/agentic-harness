import { describe, expect, it, vi } from "vitest";
import { SummaryManager } from "../src/summary-manager";
import type { SymbolSearchResult } from "@agent-harness/cbm-adapter";

describe("SummaryManager", () => {
  it("getSummary returns deterministic summary from CBM symbols", async () => {
    const mockSymbols: SymbolSearchResult[] = [
      {
        qualified_name: "app.AuthService.login",
        label: "Function",
        file: "src/auth.ts",
        lines: "10-20",
        in_degree: 3,
        out_degree: 2,
      },
      {
        qualified_name: "app.AuthService.logout",
        label: "Function",
        file: "src/auth.ts",
        lines: "22-30",
        in_degree: 1,
        out_degree: 0,
      },
    ];

    const mockAdapter = {
      searchSymbols: vi.fn().mockResolvedValue(mockSymbols),
    };

    const manager = new SummaryManager(mockAdapter as never, "src/auth.ts", "fake_hash_123");
    const summary = await manager.getSummary();

    expect(summary.path).toBe("src/auth.ts");
    expect(summary.hash).toBe("fake_hash_123");
    expect(summary.symbols).toContain("app.AuthService.login");
    expect(summary.symbols).toContain("app.AuthService.logout");
    expect(summary.generated_at).toBeGreaterThan(0);
  });

  it("normalizes slash direction when matching CBM file paths", async () => {
    const mockSymbols: SymbolSearchResult[] = [
      {
        qualified_name: "app.WindowsPath",
        label: "Function",
        file: "src\\windows.ts",
        lines: "1-10",
        in_degree: 0,
        out_degree: 0,
      },
    ];
    const mockAdapter = { searchSymbols: vi.fn().mockResolvedValue(mockSymbols) };

    const manager = new SummaryManager(mockAdapter as never, "src/windows.ts", "hash_windows");
    const summary = await manager.getSummary();

    expect(summary.symbols).toEqual(["app.WindowsPath"]);
  });

  it("getSummary returns empty symbols when CBM finds nothing", async () => {
    const mockAdapter = {
      searchSymbols: vi.fn().mockResolvedValue([]),
    };

    const manager = new SummaryManager(mockAdapter as never, "src/empty.ts", "hash_empty");
    const summary = await manager.getSummary();

    expect(summary.symbols).toEqual([]);
    expect(summary.path).toBe("src/empty.ts");
  });

  it("getSummary caches result and does not call CBM twice", async () => {
    const mockSymbols: SymbolSearchResult[] = [
      {
        qualified_name: "app.Foo",
        label: "Function",
        file: "src/foo.ts",
        lines: "1-10",
        in_degree: 0,
        out_degree: 0,
      },
    ];

    const mockAdapter = {
      searchSymbols: vi.fn().mockResolvedValue(mockSymbols),
    };

    const manager = new SummaryManager(mockAdapter as never, "src/foo.ts", "hash_foo");
    await manager.getSummary();
    await manager.getSummary();

    expect(mockAdapter.searchSymbols).toHaveBeenCalledTimes(1);
  });

  it("getSummary regenerates when hash changes", async () => {
    const mockSymbols: SymbolSearchResult[] = [
      {
        qualified_name: "app.Bar",
        label: "Function",
        file: "src/bar.ts",
        lines: "1-10",
        in_degree: 0,
        out_degree: 0,
      },
    ];

    const mockAdapter = {
      searchSymbols: vi.fn().mockResolvedValue(mockSymbols),
    };

    const manager = new SummaryManager(mockAdapter as never, "src/bar.ts", "hash_v1");
    await manager.getSummary();

    manager.updateHash("hash_v2");
    await manager.getSummary();

    expect(mockAdapter.searchSymbols).toHaveBeenCalledTimes(2);
  });
});
