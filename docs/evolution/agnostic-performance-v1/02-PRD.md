# PRD — portabilidade e economia com paridade funcional

Estado: proposta para implementação SDD/TDD; critérios AP-01–AP-42 em `acceptance-catalog.json`. O usuário solicitou esta linha de evolução; isso não constitui review semântico nem PASS de release.

## Problema e objetivo
O harness tem mecanismos relevantes de economia, mas o custo de executar qualificação completa repetidamente permanece alto, e existem convenções de layout, toolchains, adapters e contratos que limitam portabilidade. Evoluir esses mecanismos sem duplicar caches/memória e sem confundir velocidade com correção.

## Requisitos
R01. Um ProjectDescriptor identifica projeto/módulos, raízes de evidência, comandos, capacidades, runners, isolamento, políticas de contexto e limites. Um projeto sem package.json não recebe npm implícito.
R02. Toda escrita tem owner global único, e todo comando executável tem autoridade independente da saída do modelo. Descoberta de um comando não é autorização para executá-lo com segredos/efeitos externos.
R03. Preservar integralmente P01–P16. A nova arquitetura reutiliza context-cache/context-redis/context-semantic-cache/context-pack/project-memory; não adiciona stores equivalentes concorrentes.
R04. Contexto recuperado é informação, não política. Aprovação de review, scope de escrita e certificados continuam verificados localmente contra autoridade explícita.
R05. Operações mecânicas — parsing, identidade, serialização, enum, ownership, compilação, execução/inspeção de testes — não requerem modelo. Ambiguidade de produto continua semântica; determinismo não inventa fatos.
R06. Budget único de inferência inclui tentativa primária, projeções, retries, fallbacks e startup. Nova tentativa sem nova evidência/progresso deve parar com diagnóstico, não consumir indefinidamente o orçamento.
R07. Qualificação tem subject e proofKind explícitos. Quick/deterministic bloqueiam inferência remota inclusive via fallback. Provider fixture não simula DB, fila, worker, lease ou processo cuja recuperação se quer provar.
R08. Release certifica SHA exato com closure de provas. Reuse de receipt exige inputs completos/idênticos, ambiente e policy compatíveis; saúde corrente, cleanup e side effects não viram PASS por cache. Memória/semantic cache não substituem proof store.
R09. Consumer qualification inspeciona integração do consumidor real; não repete implicitamente todo standalone e não chama outra coisa de consumer PASS.
R10. Um codec de source/manifest elimina divergência de ordem de propriedades, encoding, modo de arquivo e gitlink; verificador batch reduz subprocessos sem enfraquecer integridade.
R11. Métricas distinguem savings estimado, bytes efetivamente enviados, usage reportado e custo desconhecido. Model prompt cache, retrieval cache e receipt cache são domínios diferentes; evitar dupla contagem.
R12. Perfis e adapters têm testes de conformidade, capability missing explícita e rollback; sem remoção silenciosa de TS/Vitest, Redis/PG e testes de recuperação para ficar rápido.

## Não objetivos
Não trocar PostgreSQL/RabbitMQ/Rust apenas por hipótese de latência. Não reintroduzir SQLite steady-state. Não adotar Mem0/MemoryOS como segunda autoridade. Não tornar a execução arbitrária de plugins/commands automaticamente segura. Não garantir compatibilidade com literalmente toda ferramenta sem adapter declarado. Não automatizar aprovação de mudança semântica por similaridade.

## SLOs propostos, não medidos
No corpus e hardware fixados por T00/T16: quick warm p95≤90s; deterministic warm p95≤5min; release referência p50≤12min e p95≤18min; consumer overhead p95≤3min fora do tempo dos testes do produto. Cold downloads e validações live estendidas têm classe separada. Qualidade, isolamento e R-9/R-10 equivalentes prevalecem sobre SLO.

## Gate para aceitação
Todos os critérios aplicáveis com prova verificável, matriz P01–P16 sem regressões não aprovadas, perfis identificados, budgets auditáveis e rollback ensaiado. NOT_RUN/PENDING/UNKNOWN não são PASS. Requisitos pendentes não desaparecem do handoff.
