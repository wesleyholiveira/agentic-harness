# Qualificação e desempenho

## Escopos propostos
- quick: contratos, schemas, análise de impacto, unit/diferenciais; inferência remota proibida por enforcement e contabilizada como zero observado.
- deterministic: provider controlado; PostgreSQL/RabbitMQ/Rust worker, leases, fencing, outbox, checkpoint e perda física reais quando requeridos; testar também Redis/TEI pelos protocolos reais. Não rotular simulated como live.
- live-adapter: smoke bounded de host/provider real, current-user-message e structured-output; budgets e identidade do provider explicitados.
- release: closure obrigatória para SHA exato; inclui provas de recuperação/outage/cleanup, compatibilidade e security. Pode referenciar receipts reutilizáveis apenas com identidade completa e política de confiança.
- consumer: ProjectDescriptor/runner/policy/lock e integração do consumidor REAL; testes do produto têm duração separada. Não chamar standalone e relabel como consumer.

## Matriz de preservação obrigatória
Q01 L1 warm hit, L2 promotion, TTL/no-TTL, clock boundary, invalidation/deletion e ausência de entrada L1 residual após falha fail-closed de escrita.
Q02 Redis exact replicas fresh/fresh, fresh/stale, fresh/missing, um endpoint down, total outage open/closed, late replies e recuperação sem restart.
Q03 Semantic miss/rejected/observe/enforce/off; project/branch/role/stage/schema/model/visibility diferenças; revision/hash/coverage mismatch; exact hit sem embedding/semantic lookup.
Q04 ProjectMemory persist/restart, isolamento homônimos, concurrent writes/revisions, busca e Unicode/phrases, Decision.files rename/delete histórico, conflitos idempotentes.
Q05 raw/component/static caches, troca de budget, compact/full, lazy ctxref resolution, truncation metadata e dependências; cold e warm não trocam autoridade.
Q06 Contabilização: uma lookup rejeitada conta uma vez, component hits não contam como pack hit, estimates não se somam ao usage do provider, unknown não vira zero.
Q07 Paridade kernel: entrypoints atuais equivalentes, replay idempotente, process-loss same attempt, stale result reject, interruption during repair, resume e ausência de dupla integração.
Q08 Prova de segurança: cross-session ingress idêntico, nonce replay, mensagem multipart/Unicode, arquivo/anchor inventado, command injection, env secret leakage, symlink e path traversal.
Q09 Proof reuse: alteração de schema/policy/prompt/AGENTS/test/fixture/toolchain invalida receipts dependentes; diff desconhecido invalida conservadoramente; cleanup/live freshness não cacheiam sucesso corrente.

## Medição
O relato do usuário 30–50min é uma observação operacional, não uma distribuição medida. Relatório histórico standalone-v1-1789868670447-bc7a5e766268 tem cerca de 24min, HOLD R-9 e R-10 NOT RUN. Não usar isso como p95 ou certificado do baseline atual.
T00 extrai fase por fase sem inferir que todo R-7/R-9 é tempo de modelo. T16 registra startup, install/build, index/retrieval, cache probes, embeddings, fila, modelo, repair, validação, polling, cleanup e caminho crítico. Intervalos concorrentes não são somados como wall time.
Benchmark: pelo menos 10 warm e 3 cold por cenário como baseline inicial; para alegação p95, declarar amostra/estimador e ampliar amostra suficiente. Fixar hardware, concorrência, source, configuração, modelo, imagens, região quando conhecida; preços ausentes ficam null. Comparar p50/p95 observados, failures/HOLD, prompts/bytes/tokens reportados e estimados separados.

## Economia segura
Reaproveitar pool/processo/dependências e provar cache hits existentes antes de criar outro mecanismo. IDs de consumidores temporários podem impedir reuse: medir, não remover isolamento para elevar hit rate. Paridade cache-off/on compara conteúdo/autoridade e completude de evidência, não timestamp/pack_id idênticos. Não propor limiar numérico de hit-rate universal; tarefas diferentes legitimamente produzem misses.
SLO nunca converte timeout, infraestrutura degradada ou requisito faltante em PASS. Ganho desejado inclui menos requests remotos para mecânica, não apenas TTL maior ou modelo menor.
