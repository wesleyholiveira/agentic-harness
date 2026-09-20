# Contrato comum dos Task Briefs de planejamento

Todos os JSONs deste diretório são `planning-task/v2`, status planned. Herdam a branch/baseline de execution-plan.json, os contratos de 04-CONTRACTS e o runbook de SDD/TDD. Não são handoffs aprovados nem Task Briefs de run.

Antes de cada task: resolver dependencies, sourceRefs e contextPacketId; Technical Lead resolve agente autorizado e expande writePaths contra a árvore real e arquivos novos. Owner é global por arquivo, não é o reviewer nem o coordinator. Overlap serializado também é rejeitado. Inputs não concedem escrita. Sem caminho alocado, revisar o grafo antes de editar.

T00 é análise host sem escrita de produto. T17 é fechamento host/release, não workload a enviar a agent_start. Tasks de implementação seguem o ingresso Runtime existente; nenhum novo perfil CLI é presumido antes de T13.

## Validação de cada implementação
`redTests` são cenários a reproduzir/escrever, não resultados executados. Usar o arquivo de teste específico listado em writePaths; `node --test <arquivo .test.mjs>` ou o runner Vitest de package escolhido em T00, SOMENTE após arquivo existir e comando ter autoridade no Task Brief. `npm run harness:test` existe no baseline e cobre contracts; não substitui as suites TypeScript, Redis/PostgreSQL e runtime/fault. Execute os testes afetados do package, os de paridade P/Q e os contracts agregados adequados. Ferramenta/serviço indisponível é HOLD.

Registrar RED real para a lacuna nova, BASELINE_GREEN para invariantes preexistentes, GREEN da correção e regressão negativa. Nenhum skip novo para mascarar falha. Handoff registra comandos exatos, runner/versão/cwd, sourceBefore/After, exit codes e logs/digests, critérios atendidos/pendentes/bloqueados e rollback. Template: ../handoffs/IMPLEMENTATION-RESULT.template.json.

Orçamento: parsing/hash/manifest/planejamento mecânico/fixture e validações locais usam zero inferência remota; necessidade semântica passa pelo ledger único. Unknown price/token é null. Não imprimir segredos. Aprovação/qualificação só com evidência e policy autoritativas.

Migration SQL é responsabilidade exclusiva de T20: verificar próximo número, criar apenas migration nova quando necessária, preservar arquivos históricos. Root package/lock são responsabilidade T13. MANIFEST.json pertence T17 para fechamento da implementação; eventual refresh documental anterior é uma operação host isolada e registrada, nunca hash manual ou certificado herdado.

Leitura adicional obrigatória: `../08-EXTENSION-PARITY.md`. O inventário P01–P16 é mínimo; features existentes não enumeradas também exigem preservação, owner e teste antes de refactor.

## Amendment R3 obrigatório — toolchain Docker
Antes de executar qualquer probe/build/test de projeto containerizado, ler `../09-DOCKER-TOOLCHAIN-AUTHORITY.md` e `../docker-toolchain-contract.json`. Todos os T00–T21 herdam as regras DTC aplicáveis, inclusive os exemplos Node/Vitest acima: são comandos internos do runner declarado, não uma exigência de instalar o SDK do projeto no host. Host é autoridade apenas para ferramentas explicitamente host-side do controller. A ausência de binário no host não é causa de falha de toolchain containerizado; a presença no host não prova o container. T01/T03/T04/T11/T13 implementam o contrato/runner; T15/T16 comprovam negativos e desempenho. DTC complementa os critérios AP, sem remover P01–P16 ou mudar ownership.
