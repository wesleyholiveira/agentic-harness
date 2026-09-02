export interface Decision {
  id: string;
  title: string;
  content: string;
  rationale: string;
  files: string[];
  symbols: string[];
  commit: string;
  created_at: number;
}

export interface TaskRecord {
  id: string;
  task_desc: string;
  context_pack_hash: string;
  outcome: string;
  files_touched: string[];
  created_at: number;
}

export interface DecisionQuery {
  query: string;
  limit?: number;
}
