export interface FileSummary {
  path: string;
  hash: string;
  symbols: string[];
  imports: string[];
  defined_symbols: string[];
  responsibility_hint: string;
  generated_at: number;
}

export interface EnrichedSummary extends FileSummary {
  enriched_content: string;
  enriched_at: number;
  enrichment_model?: string;
}

export interface ModuleSummary {
  dir_path: string;
  file_summaries: FileSummary[];
  total_symbols: number;
  generated_at: number;
}
