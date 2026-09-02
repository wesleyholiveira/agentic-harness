export type SemanticDependency = "redis" | "embedding" | "unknown";

export class SemanticDependencyUnavailableError extends Error {
  readonly code = "context_semantic_dependency_unavailable";
  readonly retryable = true;
  readonly category = "context-infrastructure";

  constructor(
    readonly dependency: SemanticDependency,
    readonly causeCode: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`context_semantic_dependency_unavailable:${dependency}:${causeCode}:${message}`, options);
    this.name = "SemanticDependencyUnavailableError";
  }
}

export function isSemanticDependencyUnavailableErrorLike(error: unknown): error is {
  code: string; dependency?: SemanticDependency; causeCode?: string; retryable?: boolean; message?: string;
} {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "context_semantic_dependency_unavailable"
  );
}

export function semanticDependencyError(
  dependency: SemanticDependency,
  error: unknown,
  fallbackCauseCode: string,
): SemanticDependencyUnavailableError {
  if (error instanceof SemanticDependencyUnavailableError) return error;
  if (isSemanticDependencyUnavailableErrorLike(error)) {
    const preservedDependency = error.dependency ?? dependency;
    const preservedCauseCode = error.causeCode ?? fallbackCauseCode;
    const preservedMessage = typeof error.message === "string" ? error.message : String(error);
    return new SemanticDependencyUnavailableError(preservedDependency, preservedCauseCode, preservedMessage, {
      ...(error instanceof Error ? { cause: error } : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : fallbackCauseCode;
  return new SemanticDependencyUnavailableError(dependency, causeCode, message, {
    ...(error instanceof Error ? { cause: error } : {}),
  });
}
