export interface SymbolInfo {
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  body?: string;
}
