export interface SymbolSearchResult {
  qualified_name: string;
  label: string;
  file: string;
  lines: string;
  in_degree: number;
  out_degree: number;
}

export type ArchitectureResult = string;

export interface TracePathNode {
  qualified_name: string;
  label?: string;
  file: string;
  lines?: string;
  depth: number;
}

export interface TracePathResult {
  direction: string;
  nodes: TracePathNode[];
  total: number;
}

export interface CodeSnippetResult {
  qualified_name: string;
  code: string;
  file: string;
  lines: string;
}

export interface CoverageResult {
  covered: boolean;
  missed_ranges: string[];
}

export interface IndexStatusResult {
  project: string;
  nodes: number;
  edges: number;
  status: string;
}
