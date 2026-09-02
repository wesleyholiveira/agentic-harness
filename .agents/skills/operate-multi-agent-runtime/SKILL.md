# Operate Multi-Agent Runtime

## Use when

Use this skill when a repository change must be planned, executed, resumed, retried, observed or summarized through Dynamic DAG V2.

## Normal agent-driven procedure

1. Use the Context Engine MCP tool `agent_start` with the complete implementation request. This persists the run and returns immediately.
2. Let Product Owner, governance reviews and Technical Lead run through the persisted bootstrap. The Technical Lead `implementationPlan` is compiled into the authoritative implementation DAG.
3. Use `agent_wait` for bounded long-polling, `agent_get_dag` when the compiled DAG itself is needed, and `agent_status` for point-in-time lifecycle/task state. Do not busy-poll.
4. The runtime builds every Context Packet through the **same in-process Context Engine provider** used by `context_get_task_context`, including L1/L2 cache and `ctxref` storage. A subprocess context bridge is prohibited.
5. Use `agent_retry` only for a failed/blocked/cancelled task within its attempt budget. Model escalation is selected by the runtime.
6. Use `agent_resume` after an interrupted Context Engine/OpenCode session.
7. Use `agent_cancel` to stop a run; persisted cancellation is authoritative and active executor subprocesses observe it.
8. Use `agent_summary` for acceptance/retry/model/cost telemetry before tuning model policy or parallelism.
9. Never claim completion unless the runtime reaches product acceptance and its completion gates prove every blocking criterion.

## Break-glass CLI

The `npm run agent:*` commands remain for debugging, CI, recovery and operator inspection. They are **not** required in the normal OpenCode workflow and the user should not be asked to run them to start ordinary implementation work. CLI execution uses an in-process Context Engine provider as well.

Typical emergency commands:

```bash
npm run agent:doctor
npm run agent:status -- --run <run-id>
npm run agent:resume -- --run <run-id>
npm run agent:retry -- --run <run-id> --task <task-id>
```

## Completion evidence

- bootstrap and compiled execution DAG;
- validated Task Brief/Context Packet artifacts;
- criterion-by-criterion Handoff Results;
- integration decision/product acceptance;
- model, steps, token/cache and cost telemetry;
- explicit conflicts, blocked validations and residual risks.
