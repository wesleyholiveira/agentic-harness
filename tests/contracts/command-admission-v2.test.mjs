import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandContractDigest, evaluateExecutionPolicy, executionPolicyDigest, validateExecutionPolicy,
} from '../../packages/harness-contracts/src/execution-policy.mjs';
import { projectDescriptorDigest } from '../../packages/harness-contracts/src/project-descriptor.mjs';
import { dockerRunnerDigest } from '../../packages/harness-contracts/src/docker-runner.mjs';
import { probeDockerImageToolchain } from '../../packages/project-adapters/src/docker-toolchain.mjs';

const H = 'sha256:' + 'a'.repeat(64);
const CID = 'c'.repeat(64);
function runner(overrides={}) {
  return { schemaVersion:'docker-runner-ref/v1',id:'test-runner',kind:'docker-compose',dockerContext:'default',daemonId:'daemon-a',composeProject:'example',
    composeFiles:[{path:'compose.yaml',sha256:H}],profiles:['test'],service:'tests',purpose:'test',operation:'exec',replica:1,
    containerCwd:'/workspace',user:'1000:1000',platform:'linux/amd64',buildTarget:'test',imageId:H,configPublicSha256:H,sourceSnapshotSha256:H,mountsSha256:H,dependencyLockSha256:H,...overrides };
}
function command(overrides={}) {
  return { schemaVersion:'command-spec/v1',id:'unit',moduleId:'api',runnerId:'test-runner',phase:'behavior',executable:'pytest',argv:['-q'],
    cwd:'services/api',envAllowlist:[],secretRefs:[],requiredCapabilities:['language.python'],networkPolicy:'none',effects:['workspace-write'],timeoutMs:60000,
    dependencyPolicy:'required',validationScope:'workspace',...overrides };
}
function descriptor(overrides={}) {
  return { schemaVersion:'project-descriptor/v1',projectId:'project-a',repositoryId:'repository-a',policyRef:'policy/engineering-v1',
    modules:[{id:'api',root:'services/api',languages:['python'],requiredCapabilities:['language.python']}],
    evidenceRoots:['docs'],protectedPaths:['.harness','.env'],runners:[runner()],commands:[command()],...overrides };
}
function policy(d=descriptor(), grantOverrides={}) {
  const c=d.commands[0], r=d.runners[0];
  return { schemaVersion:'execution-policy/v1',id:d.policyRef,projectId:d.projectId,descriptorDigest:projectDescriptorDigest(d),grants:[{
    commandId:c.id,commandDigest:commandContractDigest(c),runnerDigest:dockerRunnerDigest(r),allowedScopes:['workspace'],allowedNetworkPolicies:['none'],
    allowedEffects:['workspace-write'],maxTimeoutMs:60000,allowSecrets:false,...grantOverrides
  }]};
}
function observation(r=runner(), overrides={}) {
  return { schemaVersion:'docker-identity-observation/v1',status:'PARTIAL',code:'docker_identity_observed',runnerId:r.id,runnerDigest:dockerRunnerDigest(r),
    toolchain:'NOT_RUN',behavior:'NOT_RUN',configurationVerified:false,sourceSnapshotVerified:false,mountsVerified:false,trustVerified:false,
    qualificationVerdict:null,imageId:r.imageId,containerId:CID,calls:5,elapsedMs:12,...overrides };
}
function fakeDocker(mapping={}) {
  const calls=[];
  const execute=argv=>{
    calls.push(argv);
    const i=argv.indexOf('--entrypoint'), executable=argv[i+1];
    const value=mapping[executable];
    if (typeof value === 'function') return value(argv);
    if (value) return value;
    return {status:127,stdout:'',stderr:'not found'};
  };
  return {calls,execute};
}

test('exact policy grant is structurally satisfied but never establishes source trust or execution authority',()=>{
  const d=descriptor(), p=policy(d), result=evaluateExecutionPolicy({policy:p,descriptor:d,commandId:'unit'});
  assert.equal(result.status,'CONTRACT_SATISFIED');
  assert.equal(result.trustVerified,false);
  assert.equal(result.authorization,'pending-source-trust');
  assert.equal(result.qualificationVerdict,null);
  assert.equal(executionPolicyDigest(p).startsWith('sha256:'),true);
});
for(const [name,mutate,reason] of [
  ['descriptor changed',d=>d.commands[0].argv.push('--maxfail=1'),'descriptor-digest-mismatch'],
  ['policy ref changed',d=>d.policyRef='policy/other','policy-ref-mismatch'],
  ['project changed',d=>d.projectId='project-b','project-mismatch'],
]) test(`policy evaluation holds when ${name}`,()=>{
  const original=descriptor(), p=policy(original), changed=structuredClone(original); mutate(changed);
  const result=evaluateExecutionPolicy({policy:p,descriptor:changed,commandId:'unit'});
  assert.equal(result.status,'HOLD'); assert.ok(result.reasons.includes(reason));
});
for(const [name,grantChange,commandChange,reason] of [
  ['command digest',{},c=>c.argv.push('--x'),'descriptor-digest-mismatch'],
  ['runner digest',{runnerDigest:'sha256:'+'b'.repeat(64)},null,'runner-digest-mismatch'],
  ['scope',{allowedScopes:['container']},null,'scope-forbidden'],
  ['network',{allowedNetworkPolicies:['service-only']},null,'network-forbidden'],
  ['effect',{allowedEffects:['read-only']},null,'effect-forbidden'],
  ['timeout',{maxTimeoutMs:1000},null,'timeout-exceeds-policy'],
]) test(`grant fails closed for ${name}`,()=>{
  const d=descriptor();
  if(commandChange) commandChange(d.commands[0]);
  const p=policy(d,grantChange);
  if(name==='command digest') p.grants[0].commandDigest='sha256:'+'b'.repeat(64);
  const result=evaluateExecutionPolicy({policy:p,descriptor:d,commandId:'unit'});
  assert.equal(result.status,'HOLD'); assert.ok(result.reasons.includes(reason));
});
test('secret-bearing command requires an explicit secret grant',()=>{
  const d=descriptor(); d.commands[0].secretRefs=['secret/db-test'];
  let result=evaluateExecutionPolicy({policy:policy(d),descriptor:d,commandId:'unit'});
  assert.ok(result.reasons.includes('secrets-forbidden'));
  result=evaluateExecutionPolicy({policy:policy(d,{allowSecrets:true}),descriptor:d,commandId:'unit'});
  assert.equal(result.status,'CONTRACT_SATISFIED'); assert.equal(result.trustVerified,false);
});
test('policy rejects unknown fields and duplicate grants',()=>{
  const d=descriptor(), p=policy(d); p.approved=true;
  assert.throws(()=>validateExecutionPolicy(p));
  const q=policy(d); q.grants.push(structuredClone(q.grants[0]));
  assert.throws(()=>validateExecutionPolicy(q));
});

test('Docker image toolchain probe runs fixed Python version probe, never behavior command',()=>{
  const d=descriptor(), fake=fakeDocker({python:{status:0,stdout:'Python 3.12.4\n',stderr:''}});
  const receipt=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute,root:'/project'});
  assert.equal(receipt.status,'TOOLCHAIN_VERIFIED'); assert.equal(receipt.code,'docker_image_toolchain_verified');
  assert.deepEqual(receipt.tools.map(x=>[x.capability,x.executable,x.version]),[['toolchain.python','python','3.12.4']]);
  assert.equal(receipt.trustVerified,false); assert.equal(receipt.qualificationVerdict,null); assert.equal(receipt.remoteCalls,0);
  const argv=fake.calls[0];
  for(const pair of [['--network','none'],['--pull','never'],['--entrypoint','python'],['--platform','linux/amd64']]) {
    const i=argv.indexOf(pair[0]); assert.equal(argv[i+1],pair[1]);
  }
  assert.ok(argv.includes('--read-only')); assert.ok(argv.includes('--cap-drop')); assert.ok(argv.includes(H));
  assert.ok(!argv.includes('pytest')); assert.ok(!argv.includes('-q'));
});
test('Python falls back to python3 deterministically when python is absent',()=>{
  const d=descriptor(), fake=fakeDocker({python:{status:127,stdout:'',stderr:''},python3:{status:0,stdout:'Python 3.11.9\n',stderr:''}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'TOOLCHAIN_VERIFIED'); assert.equal(r.tools[0].executable,'python3'); assert.equal(fake.calls.length,2);
});
test('identity mismatch prevents any toolchain process from starting',()=>{
  const d=descriptor(), fake=fakeDocker({python:{status:0,stdout:'Python 3.12.4',stderr:''}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0],{imageId:'sha256:'+'b'.repeat(64)})},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'toolchain_identity_observation_required'); assert.equal(fake.calls.length,0);
});
test('unrecognized output is HOLD and receipt never exposes raw output',()=>{
  const d=descriptor(), fake=fakeDocker({python:{status:0,stdout:'Python 3.12.4\nPRIVATE_TOKEN=secret',stderr:''}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'toolchain_version_unrecognized'); assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
});
test('Docker CLI absence is HOLD and never falls back to host Python',()=>{
  const d=descriptor(), fake=fakeDocker({python:{status:null,stdout:'PRIVATE',stderr:'PRIVATE',error:{code:'ENOENT'}}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'docker_command_unavailable'); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('unsupported language is explicit HOLD with zero process calls',()=>{
  const d=descriptor(); d.modules[0].languages=['elixir']; const fake=fakeDocker();
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'toolchain_language_unsupported'); assert.equal(fake.calls.length,0);
});
test('docs-only command does not invent a runtime toolchain',()=>{
  const d=descriptor(); d.modules[0].languages=['docs']; const fake=fakeDocker();
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'toolchain_probe_not_declared'); assert.equal(fake.calls.length,0);
});
test('Rust requires both rustc and cargo; missing one is HOLD',()=>{
  const d=descriptor(); d.modules[0].languages=['rust'];
  const fake=fakeDocker({rustc:{status:0,stdout:'rustc 1.90.0 (abc 2026-01-01)\n',stderr:''},cargo:{status:127,stdout:'',stderr:''}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'HOLD'); assert.equal(r.code,'toolchain_capability_unavailable'); assert.equal(r.missingCapability,'toolchain.cargo');
  assert.deepEqual(r.tools.map(x=>x.capability),['toolchain.rustc']);
});
test('Java version on stderr is accepted without returning stderr body',()=>{
  const d=descriptor(); d.modules[0].languages=['java'];
  const fake=fakeDocker({java:{status:0,stdout:'',stderr:'openjdk version "21.0.5" 2026-01-01\nOpenJDK Runtime Environment\n'}});
  const r=probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  assert.equal(r.status,'TOOLCHAIN_VERIFIED'); assert.equal(r.tools[0].version,'21.0.5'); assert.equal(r.stderr,undefined);
});
test('probe command never receives env/secret refs or service command argv',()=>{
  const d=descriptor(); d.commands[0].envAllowlist=['PUBLIC_FLAG']; d.commands[0].secretRefs=['secret/db'];
  const fake=fakeDocker({python:{status:0,stdout:'Python 3.12.4',stderr:''}});
  probeDockerImageToolchain({descriptor:d,commandId:'unit',identityObservation:observation(d.runners[0])},{execute:fake.execute});
  const flat=fake.calls.flat(); assert.ok(!flat.includes('PUBLIC_FLAG')); assert.ok(!flat.includes('secret/db')); assert.ok(!flat.includes('pytest'));
});
