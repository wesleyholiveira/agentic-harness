# Paridade do inventário ampliado

P01–P16 são um conjunto mínimo, não uma autorização para remover features não enumeradas. T00 deve registrar também os mecanismos efetivos de Headroom/RTK, compressão de outputs, manifests de input, anexação de arquivos, receipts de leitura, deduplicação de prompts/artefatos, cache de adapters e reutilização determinística já presentes no checkout. A presença de um helper/import não prova sua ativação em todos os caminhos: registrar implemented, wired, enabled e measured separadamente.

Para cada mecanismo adicional, anexar ao inventário: símbolo/path/commit, callers reais, configuração e default, cache/state scope, invalidação, failure mode, suites de proteção, métricas e owner. Benefício não medido fica desconhecido. Scripts/adapters que não tenham owner em writePaths exigem revisão explícita do DAG antes da escrita; não usar fallback genérico para editar caminhos alheios.

T09/T21 devem preservar compact refs e o fluxo de input manifesto como fontes de economia, não reconstruir texto expandido em cada prompt. T07 não passa por cima de Headroom/provider cache nem contabiliza suas estimativas duas vezes. T13 mantém adapters disponíveis conforme capability e configuração. T15/T16 verificam equivalência e atribuição de economia, incluindo fallback/degradação. Cada aposentadoria requer registro de substituição, teste de paridade e aceite explícito.

Este documento complementa R03/P01–P16 e deve ser lido no source-freeze de T00 e nos slices de contexto/semântica/integração.
