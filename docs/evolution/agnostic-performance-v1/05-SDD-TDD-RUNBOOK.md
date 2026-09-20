# Runbook SDD/TDD de implementação

## P0 — preparar sem modelos e sem mutações de domínio
T00/C00 conferem branch explícita, HEAD, árvore, status, lock/gitlink e divergências locais/remotas. Não fazer reset --hard, force-push, stash/pop automático ou checkout de outro pin para ler documentação. Guardar relatórios fora do source. Acesso remoto não prova estado local.
Inventariar entrypoints: executor legado, child launcher, finalizer event-driven, MCP/server, adapters, contextProvider e controller de qualificação. Mapear todo cache/memória/política P01–P16. A análise de um único método não prova comportamento end-to-end.
Capturar baseline determinístico e relatórios existentes; identificar campos não medidos. Não gastar outra qualificação remota só para obter contagens que podem ser extraídas localmente.

## P1 — Specification
PRD e aceitação são imutáveis no slice até revisão explícita. Architecture/database/security/performance/AI reviews são selecionadas por impacto, não executadas cosmética e serialmente. Review que não altera o domínio pode atestar no-impact com evidência; ausência de review required não é no-impact.
Technical Refinement resolve proposed owners, caminhos exatos, comandos e scopes no checkout atual; expande globs e rejeita overlap global inclusive serializado. As tarefas novas T18–T21 impedem que caches/memória virem detalhe sem owner. Modelos e thresholds são escolha benchmark-gated, não nomes de classe assumidos rápidos.

## P2 — RED por comportamento
Para cada task, escrever/reproduzir primeiro o menor cenário que falha, usando clock/runner/provider controlados onde possível. Guardar command, cwd, code revision, exit code, logs/hash e assertion behavior. Depois implementar menor correção e GREEN. Refactor somente com paridade. Regex de texto pode complementar wiring, mas não substituir teste de cache, protocolo, política ou review.
Testes de preservação não devem falhar no baseline só para fingir RED: registrar BASELINE_GREEN como proteção e adicionar RED para a nova lacuna. Rejeitar remoção de teste ou conversão em skip como prova de melhoria.

## P3 — implementação e completion
Executar comandos somente após catálogo e scope do Task Brief resolvidos. Comando/path de teste proposto e ainda inexistente deve ser criado/autorizado antes de execução; não enviar como validation pronta. Respeitar fronteiras de read-only, segredos, efeitos e timeout. Runtime gera identidade/envelope, modelo só a parte semântica necessária.
Falhas tipadas: mecânica recuperável local; ambiguidade semântica bounded; infra transitória com deadline/cooldown; política/autoridade/segurança fail-closed. Budget único impede multiplicação de retries internos×externos. Nenhum LLM reescreve status de review por sugestão de economia.

## P4 — evidência e release
Handoff obrigatório usa templates em handoffs/: sourceBefore/After, criterionIds, test receipts, cache/memory parity, usage known/unknown, riscos e rollback. Para tasks de cache, anexar resultados por warm/cold/degraded e por scope; hit rate sozinho não basta.
Antes da qualificação source candidate, executar o gerador oficial de MANIFEST e commitá-lo; não chamar --check em working tree modificado esperando PASS. Atualizar schema de planejamento não altera schema ativo automaticamente.
Qualificação host posterior usa os perfis realmente implementados. Até T13, flags --profile/--subject são especificação, não comandos existentes. Não enviar qualify/fault/promotion dentro de agent_start. Quick/benchmark não herdam autoridade release.

## Prompt para o agente executor futuro
Implemente este workstream pela branch de trabalho indicada, começando por T00 e pelo estado real do checkout. Leia 00-START-HERE, baseline/preservation, PRD, ADRs, contratos e execution-plan. Preserve P01–P16 e componha as features existentes; não recrie memória ou cache. Gere implementationPlan, Task Briefs e Context Packets no schema ativo com ownership global exclusivo. Execute SDD/TDD por slice e registre handoffs verificáveis. Não modifique main, pin nem certificados até os gates de release; qualificação/fault controller permanece operação host. Quando uma evidência faltar, reporte a lacuna e mantenha HOLD, sem fabricar aprovação.

## Amendment R3 — tooling no executor real
Obrigatório seguir `09-DOCKER-TOOLCHAIN-AUTHORITY.md` e DTC-01–DTC-08 do `docker-toolchain-contract.json`. Antes de RED/GREEN, resolver DockerRunnerRef, Compose efetivo e alvo build/test/runtime; executar a prova no container correspondente. Probe no host é somente pré-requisito do controller quando necessário, nunca substituto de toolchain de produto. Classificar declared/materialized/toolchain/behavior e anexar ToolchainEvidence a cada receipt/handoff. Testar explicitamente host ausente/container válido e host válido/container inválido. Não rodar shell arbitrário, instalar SDK no host ou recriar recursos em uso como fallback. Um ambiente obrigatório indisponível bloqueia; não vira skip ou sucesso vazio.
