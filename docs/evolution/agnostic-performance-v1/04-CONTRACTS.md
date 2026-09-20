# Contratos a implementar

Estes são requisitos de schema e vetores, não JSONs para enviar diretamente ao runtime v2 atual. T01 deverá criar schemas versionados estritos, adapters v1→v2 explícitos, rejeição de campos desconhecidos e testes de round-trip. T00 resolve localização/nomes finais antes de registrar novos packages.

## ProjectDescriptor / CommandSpec
ProjectDescriptor: contractVersion, projectId estável, modules[{id,root,languages,toolchainRefs}], evidenceRoots, protectedPaths, capabilities, commandIds, contextPolicyRef, executionPolicyRef, runnerRefs. IDs não derivam só do basename; relocação legítima segue policy, forks e projetos homônimos permanecem isolados.
CommandSpec: id, executable, argv[], cwd relativo canônico, runnerRef, toolchainRef, envAllowlist, requiredSecretRefs, networkPolicy, effects, timeoutMs, validationScope e authorityRef. Um capability adapter pode sugerir comandos; permission/budget admission local decide executar. PATH/quoting Windows e escaping POSIX são vetores obrigatórios. Não montar shell concatenando request.

## ContextScope / CacheIdentity
Separar identidade semântica de autorização: projectId, repositoryIdentity, branch/ref snapshot, role, stage, schemaVersion, policyDigest e visibility/access scope; embedding model/revision/dimensions na identidade semantic. Cada cache inclui apenas dimensões relevantes documentadas, e prova por testes que não permite reuse cruzado indevido. SourceRevisions e hashes de dependência continuam obrigatórios. Não remover a verificação de bytes para aumentar HIT.
RawPack é independente de delivery budget. Delivery é função de raw pack + budget + policy + mode; não reutilizar payload entregue com budget/policy incompatível. Component keys não podem reutilizar decisões de outro projeto só porque contagem/revisão coincidem.
CacheOutcome: exact{hit,tier}, components{hits,misses}, semantic{candidateHit,accepted,reasons,componentsReused}, freshness{checked,revisions}, timings, usageEstimate. Um semantic candidate aceito NÃO altera cacheHit/cacheTier exact legado.

## Memória e referências
ProjectMemory mantém Decision/TaskRecord e ledger transacional de revisão. Query semantics continuam equivalentes aos vetores canonical-token/phrase/OR existentes. Change data/status/revision são persistidos atomicamente; cache nunca concede permissão de gravar memória. Decision.files histórico não é dependência de existência.
ResolvedEvidence: sourceType, authorityRef, project/scope, repositoryCommit ou memoryRevision, path/selector quando aplicável, contentHash, bytes, resolvedRange, truncated e retrievalTime. Toda evidência insuficiente é explícita; não cortar um JSON/Unicode no meio e reapresentar como documento integral. ctxref/ctxpack resolvem apenas dentro do scope autorizado e revalidam digest/expiração.

## SemanticBudget / ArtifactEnvelope
Budget: run/task maxima de requests, input/output estimado/observado, wall deadlines e cost nullable. Reservations/settlement são idempotentes; retries e fallbacks debitem o mesmo ledger. Provider prompt-cache tokens, retrieval savings e evitadas chamadas de modelo não são a mesma métrica.
ArtifactEnvelope: run/task/attempt/dispatchGeneration/fencingToken + producerStage/capability + semanticRevision/parentRevision + schema/policy/source digests + payloadRef/hash. Review status só nasce de review válido; mecânica local não transforma changes_requested em approved. Controle anti-stale usa identidade completa, não max(revision) de todos os handoffs.
RequestEnvelope: session/call/userMessage/nonce, payload digest/size, original multipart textual bytes, optional normalizedText identity, purpose e expiry. Registro consumido é atômico e sessão-bound; argsDigest sozinho não decide entre sessões idênticas. Non-text attachment precisa de referência tipada e verificação, nunca conteúdo inventado.

## ActionReceipt / ReleaseCertificate
ActionReceipt: actionId/version, subject, inputClosureDigest, harness digest, test/fixture digest, policy/schema digest, runner/toolchain/image identity, actual execution result, stdout/stderr artifact hashes, timing, usage classification, provenance e reuse eligibility/freshness. Hash comprova integridade, não confiabilidade do emissor; trust policy decide aceita-los. Cache namespace de receipt nunca é o de semantic candidates.
ReleaseCertificate: candidateCommit + sourceDigest + required proof graph + executed/reused receipt IDs + subject/profile + final cleanup identity + verdict. NOT_RUN não satisfaz gate required. Assinatura/trust model deve funcionar offline conforme policy; nenhuma string PASS de ProjectMemory aprova release.

## Planejamento vs runtime
Os arquivos task-briefs desta revisão usam planning-task/v2. `writePaths` é proposta de ownership, `redTests` é teste a escrever, `validation` contém disponibilidade explícita. Nenhum campo descreve um teste futuro como já executado. Technical Lead produz posteriormente Task Brief/Context Packet/implementationPlan reais no schema então ativo.
