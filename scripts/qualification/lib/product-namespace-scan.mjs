export const PRODUCT_NAMESPACE_HISTORICAL_EXCLUSIONS = Object.freeze([
  "docs/evolution/**",
  "qualification/baseline/r17.4.5/**",
]);

export function productNamespaceOperationalPathspecs() {
  return PRODUCT_NAMESPACE_HISTORICAL_EXCLUSIONS.map(path => `:!${path}`);
}

export function productNamespaceReferenceClassification(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  if (!normalized) return "invalid";
  if (normalized.startsWith("docs/evolution/")) return "historical-evolution";
  if (normalized.startsWith("qualification/baseline/r17.4.5/")) return "historical-baseline";
  return "operational";
}
