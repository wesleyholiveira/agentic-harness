import type { CBMAdapter, SymbolSearchResult } from "@agent-harness/cbm-adapter";
import type { FileSummary } from "./types";

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export class SummaryManager {
  private cachedSummary: FileSummary | null = null;
  private cachedHash: string | null = null;

  constructor(
    private cbm: CBMAdapter,
    private filePath: string,
    private fileHash: string,
  ) {}

  async getSummary(): Promise<FileSummary> {
    if (this.cachedSummary && this.cachedHash === this.fileHash) {
      return this.cachedSummary;
    }

    // File-scoping heuristic: use the file name as the search pattern, then
    // filter by exact file path so symbols from other files never leak in.
    const fileName =
      this.filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.\w+$/, "") ?? "";
    const pattern = `.*${fileName}.*`;
    const allSymbols = await this.cbm.searchSymbols(pattern);
    const requestedPath = normalizeWorkspacePath(this.filePath);
    const symbols = allSymbols.filter(
      (symbol) => typeof symbol.file === "string" && normalizeWorkspacePath(symbol.file) === requestedPath,
    );

    const symbolNames = symbols.map((s) => s.qualified_name);
    // V0 limitation: the CBM adapter does not provide import information via
    // searchSymbols, so imports are always empty until an import-aware API exists.
    const imports: string[] = [];
    const definedSymbols = this.extractDefinedSymbols(symbols);
    const responsibilityHint = this.deriveResponsibilityHint(symbols);

    this.cachedSummary = {
      path: this.filePath,
      hash: this.fileHash,
      symbols: symbolNames,
      imports,
      defined_symbols: definedSymbols,
      responsibility_hint: responsibilityHint,
      generated_at: Date.now(),
    };
    this.cachedHash = this.fileHash;

    return this.cachedSummary;
  }

  updateHash(newHash: string): void {
    this.fileHash = newHash;
  }

  invalidate(): void {
    this.cachedSummary = null;
    this.cachedHash = null;
  }

  private extractDefinedSymbols(symbols: SymbolSearchResult[]): string[] {
    const definedLabels = new Set(["Function", "Method", "Class", "Interface", "Struct", "Enum", "Type"]);
    return symbols.filter((s) => definedLabels.has(s.label)).map((s) => s.qualified_name);
  }

  private deriveResponsibilityHint(symbols: SymbolSearchResult[]): string {
    const labels = new Set(symbols.map((s) => s.label));
    const parts: string[] = [];
    if (labels.has("Class")) parts.push("class definitions");
    if (labels.has("Function")) parts.push("function implementations");
    if (labels.has("Interface")) parts.push("interface contracts");
    if (labels.has("Route")) parts.push("HTTP route handlers");
    return parts.length > 0 ? `Contains ${parts.join(", ")}` : "No structural symbols detected";
  }
}
