import { createHmac } from 'node:crypto';
export function gatewayCapabilityProof(secret, capability, fence) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('docker_gateway_hmac_key_required');
  const values = [
    fence?.runId,
    fence?.taskId,
    Number(fence?.attempt),
    Number(fence?.dispatchGeneration),
    Number(fence?.fencingToken),
    fence?.leaseOwner,
    capability,
  ];
  const hmac = createHmac('sha256', secret);
  for (const value of values) {
    hmac.update(String(value ?? ''), 'utf8');
    hmac.update(Buffer.from([0]));
  }
  return `hmac-sha256:${hmac.digest('hex')}`;
}

function hold(code) {
  return { status: 'HOLD', code };
}

export async function createPostgresCapabilityVerifier({
  connectionString = process.env.AGENT_POSTGRES_URL ?? process.env.DATABASE_URL ?? '',
  schema = process.env.AGENT_POSTGRES_SCHEMA ?? 'public',
  pool = null,
  hmacKey = process.env.AGENT_HARNESS_DOCKER_GATEWAY_HMAC_KEY ?? '',
} = {}) {
  if (!connectionString && !pool) throw new Error('docker_gateway_postgres_url_required');
  if (Buffer.byteLength(hmacKey) < 32) throw new Error('docker_gateway_hmac_key_required');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) throw new Error('docker_gateway_postgres_schema_invalid');
  let ownedPool = pool;
  if (!ownedPool) {
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;
    ownedPool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 2_000,
      idleTimeoutMillis: 30_000,
    });
  }
  const table = name => `"${schema}"."${name}"`;

  return async function verifyCapability(request, { now = new Date() } = {}) {
    const fence = request?.executionFence;
    const capability = String(request?.capability ?? '');
    if (!fence || !capability) return hold('docker_gateway_capability_missing');
    const query = `
      SELECT
        t.status,t.attempt,t.dispatch_generation,t.fencing_token,t.lease_owner,t.lease_expires_at,
        r.status AS run_status,c.fingerprint
      FROM ${table('agent_tasks')} t
      JOIN ${table('agent_runs')} r ON r.run_id=t.run_id
      LEFT JOIN ${table('agent_task_checkpoints')} c
        ON c.task_id=t.task_id
       AND c.checkpoint_type='behavior.gateway.capability'
       AND c.attempt=$3
       AND c.dispatch_generation=$4
       AND c.fencing_token=$5
       AND c.invalidated_at IS NULL
      WHERE t.task_id=$1 AND t.run_id=$2
      ORDER BY c.created_at DESC NULLS LAST
      LIMIT 1`;
    let result;
    try {
      result = await ownedPool.query(query, [
        fence.taskId,
        fence.runId,
        Number(fence.attempt),
        Number(fence.dispatchGeneration),
        Number(fence.fencingToken),
      ]);
    } catch {
      return hold('docker_gateway_capability_store_unavailable');
    }
    const row = result.rows?.[0];
    if (!row) return hold('docker_gateway_fence_task_missing');
    if (row.run_status !== 'running' || row.status !== 'running') return hold('docker_gateway_fence_not_running');
    if (Number(row.attempt) !== Number(fence.attempt)
        || Number(row.dispatch_generation) !== Number(fence.dispatchGeneration)
        || Number(row.fencing_token) !== Number(fence.fencingToken)
        || String(row.lease_owner ?? '') !== String(fence.leaseOwner ?? '')) {
      return hold('docker_gateway_fence_identity_mismatch');
    }
    const expires = Date.parse(String(row.lease_expires_at ?? ''));
    const current = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current) {
      return hold('docker_gateway_fence_expired');
    }
    if (row.fingerprint !== gatewayCapabilityProof(hmacKey, capability, fence)) {
      return hold('docker_gateway_capability_mismatch');
    }
    return { status: 'VERIFIED', code: 'docker_gateway_capability_verified' };
  };
}
