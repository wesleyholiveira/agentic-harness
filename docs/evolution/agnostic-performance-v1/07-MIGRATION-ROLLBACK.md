# Migração, publicação e rollback

1. Preservar baseline, fixtures, APIs públicas, schemas/namespace versions e dados PostgreSQL antes de refactor. Novos contratos entram por adapters compatíveis; remover caminhos legados só após teste de paridade.
2. Não há migração de ProjectMemory para Redis/SQLite/Mem0 nesta proposta. Alteração de formato/revision exige migração transacional, backup, idempotência e teste de restauração; nunca truncar dados para recuperar desempenho.
3. Namespace/cache schema novo com incompatibilidade explícita: cold miss é seguro; reinterpretar bytes antigos não é. Reusar pool físico não mistura namespaces. Não executar FLUSHALL. TTL/failure mode/embedding thresholds exigem deltas registrados.
4. O kernel mantém authority ordering, schema checks, ownership, bootstrap facts, review revisions, lease/generation/fencing e outbox. Cada entrypoint adota o mesmo contrato; não mover toda a lógica para executor legado deixando o worker/finalizer descobertos.
5. Quando adotado, codec v2 lê v1 por adapter explícito e valida vetores antes de trocar writer/reader. Não corrigir manifest editando hash esperado. Gitlink e certificado sempre descrevem código realmente qualificado.
6. Mantemos os MANIFEST/locks/promoted SHAs vigentes intocados nesta entrega documental. Antes de qualificar o candidato de implementação, o gerador oficial deve incluir toda a documentação source-tracked e cada alteração implementada, em commit limpo. Não é permitido afirmar que o commit documental já tem PASS de runtime.
7. Release futura: T17 produz candidate + receipts/certificate e compara critérios. C03 só atualiza consumidor após release válida e prova consumer; exigir revalidação das alterações locais que não estavam no remoto observado. Não force-push main nem fazer squash após qualificar SHA sem novo certificado.
8. Rollback: selecionar último pin/certificado aceito e restaurar adapters/config via procedimento explícito; bancos não são apagados. Se migration torna downgrade inseguro, parar com HOLD e executar restauração aprovada. Reportar impacto e pendências.

Documentação é entrada comportamental quando lida pelo agente. Mudanças em PRD/ADR/AGENTS/prompt/schemas participam das closures de prova; não declarar todo .md irrelevante para economizar execução.
