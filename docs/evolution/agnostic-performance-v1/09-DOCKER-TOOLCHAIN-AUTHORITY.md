# Tooling — Docker/Compose como autoridade do toolchain

Amendment documental R3 de AP-D02/AP-D06/AP-D08. Estado: especificado, não implementado nem validado em Docker nesta entrega. Branch: `fix/agent-start-current-user-message-authority-20260919`.

## Regra de autoridade
Para projetos containerizados, o toolchain autoritativo é o do runner Docker/Compose que efetivamente executa a ação. Não basta citar Docker como alternativa: descoberta, preflight, execução e evidence devem apontar para esse ambiente. Versão instalada no host não prova disponibilidade, versão ou dependências no container; ausência no host também não reprova um toolchain válido no container. Proibir fallback silencioso para host e instalação automática de compiladores/SDKs no host para contornar a falta do runner.

Host preflight verifica apenas capacidades realmente usadas pelo controller: Git/Node quando necessários ao launcher, cliente Compose, acesso autorizado ao daemon/contexto selecionado e reachability. OpenCode host-side, quando selecionado, tem prova própria; isso não exige Python/Cargo/Java/etc. do produto no host. Um adapter não containerizado continua possível para outro projeto somente por declaração explícita; nunca como fallback oculto deste projeto.

## Resolver o alvo antes de executar
T00/T03/C00/C02 devem mapear cada commandId ao seu DockerRunnerRef. Resolver identidade do projeto Compose, caminho/base directory, lista ORDENADA de arquivos/overlays, profiles, env-file refs autorizadas, serviço, réplica/instância, purpose (build/test/runtime), cwd e user efetivos. Não adivinhar container por substring/nome fixo nem escolher qualquer serviço que possua o binário. O Context Engine é control-plane: seu Python/Node não comprova o toolchain de um worker ou serviço de produto diferente.

DockerRunnerRef e ToolchainEvidence são contratos a implementar por T01/T04/T10/T11/T13; os nomes aqui não são flags ativas. A coleta da configuração resolvida é local, limitada e sanitizada. Não imprimir `config --environment`, Config.Env completo, auth, env files ou inspects integrais em logs públicos. Registrar digest da projeção NÃO secreta e versões/referências opacas de segredos, nunca hash público bruto de segredo.

## Quatro provas distintas
1. DECLARED: Dockerfile/locks e `docker compose config --quiet` confirmam estrutura/configuração; não atestam execução.
2. MATERIALIZED: imagem/target construído ou disponível por identidade imutável. Registrar image ID local e repo digest quando existir; build local pode não ter RepoDigests. Tag isolada não é identidade.
3. TOOLCHAIN: executar probes aprovados dentro do alvo correto, com executável resolvido, versão, user, cwd, bibliotecas/dependências e lock state necessários. `--version` sozinho não prova import/test/build.
4. BEHAVIOR: executar build/test/check real no runner declarado e persistir exit code, identidade e evidência. Readiness de serviço/DB/rede/GPU é prova adicional quando requerida, não consequência automática de container running.

Todas as provas required precisam estar completas. UNKNOWN/NOT_RUN/HOLD não são PASS. Falha de contrato/asserção continua FAIL/rejeição; daemon inacessível, target ausente ou ambiente incompatível bloqueiam com causa e comando precisos, sem relaxar o gate.

## Build, test e runtime não são o mesmo target
Imagens multi-stage podem excluir compiladores/test runners do runtime final. Executar Cargo/tsc/pytest no target de build/test DECLARADO e comprovar a ligação desse target aos artefatos/imagem de runtime (Dockerfile, source/locks, build args não secretos, target, platform e digests). Não exigir Cargo no runtime minimalista nem instalar SDK no host. Se nenhum target de teste existir, planejar sua criação em T11, em vez de inventar um serviço já existente.

## Exec versus run
`docker compose exec -T --interactive=false` atua num container em execução; selecionar réplica/ID inequívoco e registrar identidade antes/depois para detectar restart/replacement durante a prova. Reservar exec de teste com escrita a um workspace de validação autorizado: não executar testes mutantes em containers de produção ou no worker que atende outro run.
`docker compose run --rm -T` cria um container one-off baseado no serviço. Isso NÃO equivale ao mesmo container vivo; registrar proofKind/instance próprios e configuração efetiva, command/entrypoint, mounts e user. Serviço/target de validação deve ser isolado; --rm remove o container, mas não desfaz escrita em volumes/bind mounts. --no-deps só quando a ação não requer dependências ou estas já foram explicitamente verificadas; nunca para ignorar integração obrigatória. One-off não prova portas publicadas/readiness do serviço vivo.

Exemplos de forma, NÃO comandos prontos: substitua valores pelo descriptor/CommandSpec aprovado; `${COMPOSE[@]}` representa argv de launcher nativo com contexto, projeto, arquivos e profiles já resolvidos.
```bash
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" exec -T --interactive=false --index "$REPLICA" --user "$RUNNER_USER" --workdir "$CONTAINER_CWD" "$SERVICE" "$EXECUTABLE" --version
"${COMPOSE[@]}" run --rm -T --user "$RUNNER_USER" --workdir "$CONTAINER_CWD" "$TEST_SERVICE" "$EXECUTABLE" "${APPROVED_ARGS[@]}"
```
Não concatenar shell a partir do prompt. Executável/args/user/cwd vêm de contratos autorizados. No Git Bash, preservar distinção de paths host-nativos e paths do container; testar a camada MSYS/cygpath do adapter, sem alterar conversão global por atalho. Daemon remoto só é compatível se vê o workspace correto; caso contrário bloquear ou materializar snapshot por mecanismo autorizado e registrar hash.

## Evidence, cache e desempenho
ToolchainEvidence contém runnerRef, purpose/proofKind, Docker context/daemon identity sanitizada, Compose project/service/replica, files/profiles/configDigest não secreto, Dockerfile/target/build inputs, imageId/repoDigest quando disponível, OS/arch/platform, containerId/instance, user/cwd, mounts/snapshot/lock digests, commandId/argv, executáveis/versões, timestamps, exit code, logs sanitizados e classificação.
Image digest sozinho não identifica bind mount mutável, writable layer, venv/node_modules/cache de dependências ou GPU/driver. Reuse de receipt considera todas as entradas relevantes e trust/freshness; atual estado running/readiness e configuração efetiva devem ser revalidados. Não invalidar todo contexto por um restart irrelevante: instance ID é proveniência da prova, enquanto inputs/capabilities relevantes compõem a chave hermética.
Reusar imagens/build layers/dependências quando a identidade corresponde. Não executar build --no-cache, pull, npm ci ou start de stack por padrão em todo doctor. Preflight read-only reutiliza inventário barato, mas não chama semantic cache/LLM para autorizar toolchain. Manter L1/L2/semantic/ProjectMemory e seus dados; este amendment não altera namespaces/TTLs/política de falha.

## Segurança e recursos
Docker daemon/socket é superfície privilegiada. Ações passam pelo controller/runner autorizado; não montar socket nem habilitar privileged automaticamente para todo agente. Separar context/env de engenharia e domínio. Não instalar dependências como reparo implícito. Network/DNS/DB devem ser provados a partir do runner relevante; localhost não é o host por convenção. GPU, quando requerida, exige alocação efetiva e probe de biblioteca no container; CPU só é alternativa explicitamente permitida pela policy.
Cleanup limitado aos recursos comprovadamente criados/possuídos pelo run. Proibidos prune global, down -v e exclusão/recriação de volumes/containers preexistentes por conveniência. Em divergência de imagem/config, não certificar tag antiga; recriação de recurso em uso exige ação autorizada, não mero restart silencioso.

## TDD e rastreabilidade
`docker-toolchain-contract.json` acrescenta DTC-01–DTC-08 aos critérios AP indicados, sem substituir AP-01–AP-42. Todos os briefs herdam este amendment via contrato comum; taskObligations distribui implementação e testes, não concede novos writePaths. T00/T03/T04/T11/T13/T15/T16 e C00/C02 devem provar host ausente/container válido, host válido/container inválido, target correto/incorreto, running vs ready, exec vs one-off, context/overlay/platform/mount drift, cache seguro e cleanup não destrutivo.

## Referências verificadas em 2026-09-20
A regra container-first vem da solicitação do usuário. Semântica das operações conferida na documentação oficial Docker (não prova do ambiente local):
- https://docs.docker.com/reference/cli/docker/compose/exec/
- https://docs.docker.com/reference/cli/docker/compose/run/
- https://docs.docker.com/reference/cli/docker/compose/config/
- https://docs.docker.com/build/building/multi-stage/
