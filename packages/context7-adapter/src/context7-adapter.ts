import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DocSnippet } from "./types";

const execFileAsync = promisify(execFile);

const LIBRARY_ID_PATTERN = /\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)/g;

export class Context7Adapter {
  constructor(private binary: string = "npx") {}

  async runCli(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.binary, args, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf-8",
    });
    return stdout.trim();
  }

  async resolveLibrary(libraryName: string, query: string): Promise<string> {
    const output = await this.runCli(["ctx7@latest", "library", libraryName, query]);
    const libraryId = output.match(LIBRARY_ID_PATTERN)?.[0];
    if (libraryId === undefined) {
      throw new Error(`No library ID found in ctx7 output for "${libraryName}"`);
    }
    return libraryId;
  }

  async getDocs(libraryId: string, query: string): Promise<DocSnippet[]> {
    const output = await this.runCli(["ctx7@latest", "docs", libraryId, query]);
    if (output === "") {
      return [];
    }
    return [{ library: libraryId, query, content: output }];
  }

  async getDocsByName(libraryName: string, query: string): Promise<DocSnippet[]> {
    const libraryId = await this.resolveLibrary(libraryName, query);
    return this.getDocs(libraryId, query);
  }
}
