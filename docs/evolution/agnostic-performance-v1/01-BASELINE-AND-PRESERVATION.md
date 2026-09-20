# Baseline, inventário e contrato de preservação

A base desta revisão é a branch de trabalho fixada em `66c13d914ec038cfa7bf27cac8c13524a19196b6`, e não a seleção implícita de main. Referências S01–S16 estão em `source-index.json`. Código existente é evidência de implementação; não equivale à prova de todas as propriedades sob concorrência, outage ou outra configuração.

## Features existentes — evoluir, não reconstruir
| ID | Feature / evidência | Decisão de preservação e prova exigida |
|---|---|---|
| P01 | `L1SessionCache` + `TieredContextCache`, S01/S02 | Manter hit RAM, TTL configurável, invalidation por dependência e promoção L2→L1; testar relógio controlado e flush/restart sem tornar L1 durável. |
| P02 | `RedisExactCache`, S01/S03 | Manter consenso exact entre réplicas, MISS conservador em degradação, deadlines/circuit cooldown e modos open/closed; jamais aceitar réplica stale como exact HIT. |
| P03 | `ContextRedisPool`, S01 | Manter pool process-scoped reutilizado por exact e semantic, namespaces e métricas distintos; não criar conexão/pool por request. |
| P04 | Raw/component cache no `ContextPackBuilder`, S04 | Raw pack independente do budget; cache de decisões, símbolos, arquitetura, artefatos e docs com dependências/revisões; reaplicar política de entrega a cada request. |
| P05 | `StaticArtifactCache`, S04/S11 | Preservar descoberta/cache de artefatos e fingerprints; adicionar configuração de raízes sem apagar defaults compatíveis. |
| P06 | Semantic candidate reuse, S05 | Preservar scope project/branch/role/stage/schema, identidade do embedding e revisão das fontes. Candidate HIT não é exact HIT; similarity nunca é autorização. |
| P07 | Allowlist `memory-decisions`/`cbm-symbols`, S05 | Não transformar o cache em resposta LLM ou Context Pack final autoritativo. Reusar somente componentes validados e reconstruir a entrega. |
| P08 | ProjectMemory PostgreSQL, S01/S07 | Manter decisões/TaskRecords, isolamento de projeto, ledger de revisão, transações e semântica da busca; Redis não vira memória durável. |
| P09 | Freshness da memória, S05 | `Decision.files` é proveniência/relevância histórica, não dependência de existência do snapshot. Renomear arquivo não invalida memória com revisão inalterada; alterar memória deve invalidar lookup. |
| P10 | `ContextReferenceStore` + compact delivery, S01/S06 | Preservar referências content-addressed, resolução lazy e rastreabilidade do conteúdo entregue. Validar hash, escopo, expiração e limites antes de resolver. |
| P11 | `budget-optimizer`, S04/S06 | Preservar orçamento e qualidade de evidência; rawTokens/deliveredTokens são estimativas quando derivados de estimador, não cobrança do provider. |
| P12 | CBM, Serena, Context7, S01 | Manter seams/adapters e papéis; tornar exigências dependentes de capacidades, sem esconder dependência obrigatória indisponível. |
| P13 | `SummaryManager`, S01/S04 | Interface já existe, mas `buildRawPack` observado emite `summaries: []`. Não atribuir economia ativa a essa seam nem ativar sumarização remota silenciosamente. |
| P14 | Stats/visibility/efficiency, S06/S12 | Manter campos exact-only de cacheHit/cacheTier e telemetria semantic separada. Novos campos são aditivos/versionados; desconhecido é null, não zero. |
| P15 | Provenance e current-user-message, S08/S09 | Preservar ingresso compacto e binding; ampliar testes de sessão/request/hash/multipart, sem reserializar o prompt via modelo. |
| P16 | Repair/reuse/durable continuation, S10/S14 | Preservar mesmo semantic attempt, leases, generations, fencing, checkpoints, dedup/outbox e autoridade de revisão. Não fabricar efeitos ou aprovações. |

## Questões a reproduzir antes de classificar como bug
1. O raw exact key observado usa task signature + source revisions; o semantic scope é verificado em outro caminho. Reproduzir isolamento de project/branch/role/stage/policy com Redis compartilhado e revisões iguais ANTES de concluir que há vazamento. Corrigir qualquer dimensão ausente de chave/namespace sem rebaixar freshness (T18/T09/T21).
2. `TieredContextCache.updateHash` delega ao L2; o pack builder também verifica dependências. Testar composição ponta a ponta, inclusive L1 já aquecido, alteração/delete/rename e revisões de memória. Não inferir stale delivery apenas por um método isolado (T18/T09).
3. `ProjectMemory` usa fallback de identidade/configuração em runtime-services. Projetos homônimos não devem colidir em store/pool compartilhado; testar descriptor/namespace efetivo (T03/T20/T21).
4. Medir reuse real em qualificação: exact hits, component hits, semantic candidate accepted/rejected, embeddings, bytes resolvidos e custo de indexação. Frio por projeto descartável pode reduzir hits; não é evidência de ausência da feature (T00/T16).

## Lacunas já sustentadas pelo código auditado
- Catálogo de comandos descobre principalmente package.json da raiz; strings/regex misturam forma executável e autoridade. Declarar CommandSpec/adapters, não criar npm fictício (S13, T03/T04).
- Harness qualify delega ao standalone; chamar o wrapper no consumidor não muda automaticamente o subject. Separar release do harness e integração do consumidor real (S15, T10/T13/C02).
- Produtor e consumidor não usam a mesma projeção canônica do manifest. Um codec compartilhado e vetores cross-platform devem substituir duplicação (S16, T02/C01).
- Projeção bounded pode receber referências sem trechos suficientes; usar ResolvedEvidence local verificado, não pedir ao LLM que valide heading que não viu (S14, T09/T06).
- Contrato de source de bootstrap exige reconciliação por discriminante resolution; normalizador e schema precisam aceitar/rejeitar os mesmos vetores (S14, T06).
- Projeções estruturadas iniciam servidores OpenCode auxiliares; contabilizar startup/requests/fallbacks antes de avaliar pooling (S10, T07/T16).

Nenhuma mudança de TTL, threshold, política de falha, allowlist, modelo ou conexão é autorizada só porque melhora hit rate. Registrar valor anterior, novo, motivo, riscos e testes.
