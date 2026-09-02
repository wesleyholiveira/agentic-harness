---
name: review-cross-agent-integration
description: Revise handoffs e integração entre dois ou mais agentes. Use quando contratos, shared paths ou versões de artefato cruzarem domínios; não substitui testes de domínio nem o gate final.
---

1. Leia o Contrato da Interação, DAG, Task Briefs e Handoff Results.
2. Confirme que cada changed path possui owner e que shared paths tiveram um único integrador.
3. Compare versões de contratos, schemas, envs, cache identities e estados persistidos.
4. Procure suposições incompatíveis, output superseded, duplicação de ownership e fallback silencioso.
5. Execute testes de fronteira capazes de falsificar a integração.
6. Registre Integration Decision com artefatos aceitos/rejeitados, conflitos resolvidos e testes restantes.
7. Escale conflito de invariantes ao Main Orchestrator e Architecture & Governance; não faça merge automático.
8. Entregue evidência compacta ao `verify-and-close-task`.
