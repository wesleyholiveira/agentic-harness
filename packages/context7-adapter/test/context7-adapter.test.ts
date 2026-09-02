import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Context7Adapter } from "../src/context7-adapter";

const DOCS_MARKDOWN = "# App Router\n\nUse the `app/` directory to define routes.";

describe("Context7Adapter", () => {
  describe("resolveLibrary", () => {
    it("parses the first /org/project library ID from CLI output", async () => {
      const adapter = new Context7Adapter();
      const mockOutput = [
        'Matching libraries for "next.js":',
        "- Library ID: /vercel/next.js",
        "- Library ID: /facebook/react",
      ].join("\n");
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const libraryId = await adapter.resolveLibrary("next.js", "app router");

      expect(libraryId).toBe("/vercel/next.js");
    });
  });

  describe("getDocs", () => {
    it("wraps CLI documentation output as a single DocSnippet", async () => {
      const adapter = new Context7Adapter();
      vi.spyOn(adapter, "runCli").mockResolvedValue(DOCS_MARKDOWN);

      const snippets = await adapter.getDocs("/vercel/next.js", "app router");

      expect(snippets).toEqual([
        {
          library: "/vercel/next.js",
          query: "app router",
          content: DOCS_MARKDOWN,
        },
      ]);
    });

    it("returns an empty array when the CLI returns no output", async () => {
      const adapter = new Context7Adapter();
      vi.spyOn(adapter, "runCli").mockResolvedValue("");

      const snippets = await adapter.getDocs("/vercel/next.js", "app router");

      expect(snippets).toEqual([]);
    });
  });

  describe("getDocsByName", () => {
    it("chains resolveLibrary then getDocs with the resolved library ID", async () => {
      const adapter = new Context7Adapter();
      const resolveSpy = vi.spyOn(adapter, "resolveLibrary").mockResolvedValue("/vercel/next.js");
      const docsSpy = vi
        .spyOn(adapter, "getDocs")
        .mockResolvedValue([{ library: "/vercel/next.js", query: "app router", content: DOCS_MARKDOWN }]);

      const snippets = await adapter.getDocsByName("next.js", "app router");

      expect(resolveSpy).toHaveBeenCalledWith("next.js", "app router");
      expect(docsSpy).toHaveBeenCalledWith("/vercel/next.js", "app router");
      expect(snippets).toEqual([{ library: "/vercel/next.js", query: "app router", content: DOCS_MARKDOWN }]);
    });
  });

  describe("runCli", () => {
    it("uses execFile from node:child_process (never exec)", () => {
      const source = readFileSync(new URL("../src/context7-adapter.ts", import.meta.url), "utf-8");
      const childProcessImport = source.split("\n").find((line) => line.includes("node:child_process"));

      expect(childProcessImport).toBeDefined();
      expect(childProcessImport).toContain("execFile");
      expect(childProcessImport).not.toMatch(/\bexec\b/);
    });
  });
});
