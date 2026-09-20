# Arquitetura e registro de decisões propostas

ADRs AP-D01–AP-D09: estado PROPOSTO, nenhuma substitui automaticamente ADR aceita. Technical Refinement/reviews devem registrar adoção, revisão e eventuais ADRs anteriores superseded por seção. PostgreSQL permanece autoridade de execução/memória; RabbitMQ transporte; Rust execução substituível; TypeScript autoridade semântica e DAG.

## AP-D01 — núcleo determinístico com portas semânticas
Convergir executor, worker-hosted path e event-driven finalizer em funções/contratos compartilhados de normalização, autoridade, validação e completion. Preservar adaptadores/fachadas e provas de equivalência antes de cortar legado. Rejeitada reescrita big-bang ou estrutura que despacha LLM para serializar JSON que o runtime já possui. T06/T08.

## AP-D02 — ProjectDescriptor e CommandSpec
Configuração explícita por projeto é autoridade para capabilities, módulos, doc roots e runners. Descoberta produz proposta sem executar código; policy aprovada autoriza. Node, Python, Go, Rust, JVM, .NET, docs-only e monorepos são matriz de adapters, não heurística universal. Comandos argv/cwd/envAllowlist/effects/runner substituem catálogo opaco de strings; shell é escape hatch explicitamente permitido. T03/T04/T05.

## AP-D03 — continuidade da arquitetura de contexto existente
Manter L1→L2 exact→semantic candidates→retrieval→component/raw pack→budget/compact→ctxref lazy. A consulta exact bem-sucedida não deve chamar embedding/semantic; source-revision probes locais necessários permanecem contabilizados. Reusar Redis pool e stores existentes; novas portas são contratos, não microserviços obrigatórios.
Memória durável é distinta de cache descartável. O SemanticBroker consulta o Context Engine, não recria memória nem cache contextual. O receipt store de qualificação é domínio separado de prova; pode compartilhar primitiva CAS validada, nunca namespace ou semântica de aprovação. T09/T18/T19/T20/T21.

## AP-D04 — ArtifactEnvelope e ResolvedEvidence
IDs/revisions/producer stage vêm do runtime, nunca payload shape. Snapshots carregam source/policy/schema/authority digests. Evidence tem conteúdo verificado ou locator resolvido, hash e identidade; arquivo existente não prova uma afirmação. source do fato é categoria discriminada, evidence contém path/trecho. Proveniência preserva mensagem original sem trim silencioso; texto normalizado derivado ganha hash próprio. T06/T09/T14.

## AP-D05 — SemanticBroker e orçamento único
Admission local autoriza chamada semântica por necessidade, confiança e budget. Reusar routing/economy já existente e instrumentar ausências; preço desconhecido é null. Não confundir modelo local com operação determinística. Pooling de servidores só após benchmark demonstrar benefício e isolamento por diretório, auth e configuração. T07.

## AP-D06 — qualificação por proof graph/subject
Separate quick, deterministic, live-adapter, release, consumer. Cenários de protocolo usam provider controlado mas DB/fila/worker reais e injeção física quando exigida. Testes live limitados comprovam host/provider real e nunca são substituídos por mocks rotulados live. Novo controller conserva traceability com Q-ENTRY/R-0…R-11. T10/T12/T13.

## AP-D07 — identidade e reuse de proofs
Um algoritmo canônico compartilhado cobre ordem, UTF-8, modos, symlinks, gitlinks e path policy. Reuse requer closure exata de inputs, código de teste, harness, runner/image/toolchain, schema, policy e freshness; alterações não mapeadas fazem invalidation conservadora. Rejeitado cache de PASS por branch, horário, similaridade ou só nome de teste. Evidência produzida em dirty snapshot pode servir diagnóstico quick, nunca certificado release. T01/T02/T10.

## AP-D08 — pipeline eficiente sem perder isolamento
Reduzir subprocessos Git via batch; cachear dependências/build por identidade e separar imagem de código/artefatos quando seguro. Concorrência bounded respeita recursos exclusivos e diretórios; não executar checks Cargo rivais no mesmo target sem isolamento. Ambiente warm não herda banco ou cache de outro projeto como autoridade. T11/T16/C01.

## AP-D09 — paridade e migração first-class
Antes de substituir um caminho, congelar contrato observável/cache namespace, golden fixtures e fault matrix. Redis exact e semantic continuam com políticas de falha explicitamente diferentes. Não migrar memória destruindo dados; backup e migração transacional, downgrade guard. Versões novas não leem silenciosamente entradas antigas incompatíveis. Adoção consumer só após certificado real para SHA exato. T00/T15/T17/T18–T21/C00–C03.

## Fluxo alvo
Pedido autenticado → RequestEnvelope/runtime admission → ProjectDescriptor/policy → Context Engine existente → exact/semantic/retrieval validados → contexto compacto → decisão determinística OU chamada SemanticBroker com budget → ArtifactEnvelope validado → DAG/completion → evidências → qualificação pelo controller host.

Partes mecânicas continuam determinísticas; escolhas semânticas permanecem explicitamente não determinísticas. O DAG operacional e o proof graph de qualificação são contratos diferentes, mesmo que compartilhem utilitários de DAG.
