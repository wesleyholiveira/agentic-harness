# Evolução agnóstica e econômica — pacote de implementação SDD/TDD

Revisão documental: 2. Estado: PLANEJADO; implementação, aceites de execução e promoção PENDENTES.
Branch exclusiva de trabalho: `fix/agent-start-current-user-message-authority-20260919`.
Baseline do harness: `66c13d914ec038cfa7bf27cac8c13524a19196b6`.

Este pacote reconcilia o planejamento de agnosticismo/desempenho com as capacidades JÁ EXISTENTES de economia de tokens. Não é uma proposta de substituir o Context Engine, criar outro semantic cache ou apagar ProjectMemory. A revisão 2 prevalece sobre o ZIP de planejamento anterior para execução deste workstream; preserva seus objetivos de portabilidade, identidade, qualificação por provas e SDD/TDD, acrescentando preservação explícita das features existentes.

## Ordem de leitura
1. `01-BASELINE-AND-PRESERVATION.md`: fonte observada, requisitos de paridade e lacunas a testar.
2. `02-PRD.md` e `acceptance-catalog.json`: requisitos e critérios bloqueantes.
3. `03-ARCHITECTURE-AND-ADRS.md`: decisões propostas, limites e alternativas.
4. `04-CONTRACTS.md`: contratos de implementação, não schemas ativos do runtime.
5. `05-SDD-TDD-RUNBOOK.md`: preparação, RED/GREEN, handoffs e regras de execução.
6. `06-QUALIFICATION-AND-PERFORMANCE.md` e `07-MIGRATION-ROLLBACK.md`.
7. `execution-plan.json`, `task-briefs/` e `context-packets.json`: unidades de trabalho e ownership.
8. `handoffs/` e `source-index.json`.

## Limites da autorização
Esta entrega adiciona documentação. Não implementa features, não aprova um resultado de modelo, não altera banco/fila, não promove `main` e não atualiza o pin do consumidor. Os Task Briefs são artefatos de planejamento, NÃO Task Brief v2 já emitidos pelo Runtime. IDs, owners finais, orçamento, runId e reviewedRevision devem vir da compilação autoritativa.

Para implementar posteriormente, Technical Refinement deve resolver capacidades reais e expandir ownership contra o checkout. Não presumir que uma classe sugerida de agente tem permissão de escrita. Não usar a proposta como bypass do ingress `agent_start`. Qualificação e fault injection pertencem ao controller host, não a uma tarefa de domínio no DAG.

## Integridade e publicação
Os SHAs acima identificam o código auditado, não o commit documental nem um futuro candidato. Novos arquivos documentais mudam a árvore Git. Antes de qualquer qualificação de source candidate, usar o gerador oficial `node scripts/internal/source-manifest.mjs --write`, revisar e commitar MANIFEST.json, e então executar `--check`. Não calcular fingerprints manualmente, não herdar PASS do baseline e não alterar o verificador do consumidor para aceitar manifest divergente. Este pacote não declara o novo checkout como distribuição qualificada.

## Preservação obrigatória
L1 RAM, L2 exact Redis, pool Redis compartilhado, semantic candidate cache, ProjectMemory PostgreSQL, raw/component/static artifact caches, ctxref/ctxpack, entrega compacta, otimização de budget, CBM, instrumentos de eficiência e recuperação determinística continuam no desenho. Uma troca interna só é aceita com teste de paridade e migração explícita. SQLite steady-state, uma segunda memória concorrente e semantic cache de aprovações/certificados ficam fora do escopo.
