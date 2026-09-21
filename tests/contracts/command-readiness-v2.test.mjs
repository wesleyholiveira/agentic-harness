import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { contractDigest, validateCommandSpec } from '../../packages/harness-contracts/src/project-descriptor.mjs';
import { projectDescriptorV2Digest } from '../../packages/harness-contracts/src/project-descriptor-v2.mjs';
import { executionPolicyV2Digest } from '../../packages/harness-contracts/src/execution-policy-v2.mjs';
import {
  dependencyFileSetDigest, dockerRunnerMaterializationIdentityDigest, dockerRunnerSourceBindingDigest,
  dockerRunnerSpecDigest, validateDockerRunnerMaterialization,
} from '../../packages/harness-contracts/src/docker-runner-v2.mjs';
import { bindWorkspaceAuthorityInputs } from '../../packages/project-adapters/src/workspace-binding.mjs';
import { probeDockerRunnerMaterialization } from '../../packages/project-adapters/src/docker-materialization-v2.mjs';
import { probeDockerToolchainV2 } from '../../packages/project-adapters/src/docker-toolchain-v2.mjs';
import { evaluateCommandReadiness } from '../../packages/project-adapters/src/command-readiness.mjs';

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const SOURCE = 'sha256:' + 'a'.repeat(64);
const IMAGE = 'sha256:' + 'b'.repeat(64);
const CID = 'c'.repeat(64);
const descriptorPath = '.agent-harness/project.json';
const policyPath = '.agent-harness/policy.json';

function spec(overrides={}) {
  return {
    schemaVersion:'docker-runner-spec/v2', id:'tests', kind:'docker-compose', dockerContext:'default',
    composeProject:'fixture', composeFiles:['compose.yaml'], profiles:['test'], service:'tests', purpose:'test',
    operation:'exec', replica:1, containerCwd:'/workspace', user:'1000:1000', platform:'linux/amd64',
    buildTarget:'test', image:{mode:'running-service',reference:null}, dependencyFiles:['package-lock.json'], ...overrides,
  };
}
function command(overrides={}) {
  return {
    schemaVersion:'command-spec/v1', id:'unit', moduleId:'root', runnerId:'tests', phase:'behavior',
    executable:'node', argv:['--test'], cwd:'.', envAllowlist:[], secretRefs:[], requiredCapabilities:['language.node'],
    networkPolicy:'none', effects:['workspace-write'], timeoutMs:60000, dependencyPolicy:'required', validationScope:'workspace', ...overrides,
  };
}
function descriptor(overrides={}) {
  return {
    schemaVersion:'project-descriptor/v2', projectId:'project-a', repositoryId:'repo-a', policyRef:policyPath,
    modules:[{id:'root',root:'.',languages:['node'],requiredCapabilities:['language.node']}],
    evidenceRoots:['docs'], protectedPaths:['.harness','.env'], runners:[spec()], commands:[command()], ...overrides,
  };
}
function policy(d=descriptor(), overrides={}) {
  const c=d.commands[0], r=d.runners[0];
  return {
    schemaVersion:'execution-policy/v2', id:'engineering-v2', projectId:d.projectId, descriptorDigest:projectDescriptorV2Digest(d),
    grants:[{
      commandId:c.id, commandDigest:contractDigest(validateCommandSpec(c)), runnerSpecDigest:dockerRunnerSpecDigest(r),
      allowedScopes:['workspace'], allowedNetworkPolicies:['none'], allowedEffects:['workspace-write'],
      maxTimeoutMs:60000, allowSecrets:false,
    }], ...overrides,
  };
}
function fixture(t, d=descriptor(), p=policy(d)) {
  const root=mkdtempSync(join(tmpdir(),'wave05-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const values={
    [descriptorPath]:JSON.stringify(d),
    [policyPath]:JSON.stringify(p),
    'compose.yaml':'services:\n  tests:\n    image: node:22\n',
    'package-lock.json':'{"lockfileVersion":3}\n',
    'src/changed.js':'export const value = 1;\n',
  };
  for(const [path,value] of Object.entries(values)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);}
  const compose=[{path:'compose.yaml',sha256:sha(values['compose.yaml'])}];
  const deps=[{path:'package-lock.json',sha256:sha(values['package-lock.json'])}];
  const binding={
    schemaVersion:'docker-runner-source-binding/v1', runnerId:d.runners[0].id, runnerSpecDigest:dockerRunnerSpecDigest(d.runners[0]),
    sourceCommit:'d'.repeat(40), sourceObjectFormat:'sha1', sourceSnapshotSha256:SOURCE,
    composeFiles:compose, dependencyFiles:deps, dependencyLockSha256:dependencyFileSetDigest(deps), trustKind:'git-commit',
  };
  const config={
    schemaVersion:'committed-project-configuration/v1', repositoryRoot:root, sourceCommit:binding.sourceCommit,
    sourceObjectFormat:'sha1', sourceSnapshotSha256:SOURCE, descriptorPath, descriptorSha256:sha(values[descriptorPath]),
    policyPath, policySha256:sha(values[policyPath]), descriptorDigest:projectDescriptorV2Digest(d), policyDigest:executionPolicyV2Digest(p),
    sourceTrustVerified:true, policyTrustVerified:true, trustKind:'git-commit-config', workingTreeChecked:false,
    workspaceBindingVerified:false, qualificationVerdict:null, descriptor:d, policy:p, runnerSourceBindings:[binding],
    commandEvaluations:{},
  };
  return {root,values,config,binding,spec:d.runners[0]};
}
function execDocker({restart=false,wrongUser=false,mountSource='C:/PRIVATE/PATH'}={}) {
  let inspectCount=0;
  const calls=[];
  const execute=(argv)=>{
    calls.push(argv);
    if(argv.includes('info')) return {status:0,stdout:JSON.stringify('daemon:alpha'),stderr:''};
    if(argv.includes('ps')) return {status:0,stdout:CID+'\n',stderr:''};
    if(argv.includes('container') && argv.includes('inspect')) {
      inspectCount++;
      return {status:0,stdout:JSON.stringify({
        id:CID,image:IMAGE,running:true,restartCount:restart&&inspectCount>1?1:0,
        startedAt:restart&&inspectCount>1?'2026-09-21T00:00:01Z':'2026-09-21T00:00:00Z',
        platform:'linux',user:wrongUser?'0:0':'1000:1000',workingDir:'/workspace',
        project:'fixture',service:'tests',replica:'1',oneoff:'False',
        mounts:[{Type:'bind',Source:mountSource,Destination:'/workspace/repository',RW:true}],
      }),stderr:''};
    }
    if(argv.includes('image') && argv.includes('inspect')) return {status:0,stdout:JSON.stringify({id:IMAGE,os:'linux',architecture:'amd64'}),stderr:''};
    if(argv.includes('exec')) return {status:0,stdout:'v22.16.0\n',stderr:''};
    return {status:1,stdout:'',stderr:'unexpected'};
  };
  return {calls,execute};
}

test('workspace binding checks only immutable authority inputs and permits unrelated implementation changes', t=>{
  const f=fixture(t);
  writeFileSync(join(f.root,'src/changed.js'),'export const value = 2;\n');
  const binding=bindWorkspaceAuthorityInputs(f.root,f.config);
  assert.equal(binding.status,'AUTHORITY_INPUTS_BOUND');
  assert.equal(binding.mismatches.length,0);
  assert.equal(binding.executableNow,false);
  assert.ok(binding.workspaceBindingDigest.startsWith('sha256:'));
});
for(const [path,reason] of [
  [descriptorPath,'workspace-input-hash-mismatch'],
  [policyPath,'workspace-input-hash-mismatch'],
  ['compose.yaml','workspace-input-hash-mismatch'],
  ['package-lock.json','workspace-input-hash-mismatch'],
]) test(`workspace binding fails closed when ${path} changes`,t=>{
  const f=fixture(t); writeFileSync(join(f.root,path),'tampered');
  const binding=bindWorkspaceAuthorityInputs(f.root,f.config);
  assert.equal(binding.status,'HOLD');
  assert.ok(binding.mismatches.some(item=>item.path===path&&item.reason===reason));
});
test('workspace binding digest cannot be forged without invalidating readiness',t=>{
  const f=fixture(t), workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const materialization={
    schemaVersion:'docker-runner-materialization/v1',runnerId:'tests',runnerSpecDigest:dockerRunnerSpecDigest(f.spec),
    sourceBindingDigest:dockerRunnerSourceBindingDigest(f.binding,{spec:f.spec}),sourceSnapshotSha256:SOURCE,
    daemonId:'daemon:alpha',imageId:IMAGE,configPublicSha256:sha('config'),mountsSha256:sha('mounts'),
    platform:'linux/amd64',containerId:CID,observedAt:new Date(0).toISOString(),
  };
  const forged={...workspace,workspaceBindingDigest:sha('forged')};
  const readiness=evaluateCommandReadiness({configuration:f.config,commandId:'unit',workspaceBinding:forged,materialization,toolchainReceipt:null});
  assert.equal(readiness.status,'HOLD'); assert.ok(readiness.reasons.includes('workspace-binding-invalid'));
});

test('exec materialization binds exact Compose instance, image, platform and safe public projections',t=>{
  const f=fixture(t), fake=execDocker();
  const result=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute});
  assert.equal(result.status,'MATERIALIZED'); assert.equal(result.materialization.containerId,CID);
  assert.equal(result.materialization.imageId,IMAGE); assert.equal(result.materialization.daemonId,'daemon:alpha');
  assert.equal(result.materialization.sourceSnapshotSha256,SOURCE);
  assert.ok(result.materialization.mountsSha256.startsWith('sha256:'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE/PATH'));
  assert.ok(fake.calls.every(argv=>!argv.includes('exec')&&!argv.includes('run')));
});
test('exec materialization rejects wrong user and container replacement/restart',t=>{
  const f=fixture(t);
  assert.equal(probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:execDocker({wrongUser:true}).execute}).status,'HOLD');
  const changed=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:execDocker({restart:true}).execute});
  assert.equal(changed.status,'HOLD'); assert.equal(changed.code,'docker_materialization_container_changed');
});
test('one-off materialization resolves only pinned image and never creates a container',t=>{
  const d=descriptor({runners:[spec({operation:'one-off',replica:null,image:{mode:'pinned-reference',reference:'example.invalid/node@sha256:'+'e'.repeat(64)}})]});
  const f=fixture(t,d,policy(d));
  const calls=[];
  const execute=argv=>{
    calls.push(argv);
    if(argv.includes('info')) return {status:0,stdout:JSON.stringify('daemon:alpha'),stderr:''};
    if(argv.includes('image')&&argv.includes('inspect')) return {status:0,stdout:JSON.stringify({id:IMAGE,os:'linux',architecture:'amd64'}),stderr:''};
    return {status:1,stdout:'',stderr:'unexpected'};
  };
  const result=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute});
  assert.equal(result.status,'MATERIALIZED'); assert.equal(result.materialization.containerId,null);
  assert.ok(calls.every(argv=>!argv.includes('run')&&!argv.includes('exec')&&!argv.includes('ps')));
});

test('toolchain v2 executes fixed probe inside exact running container and reobserves it',t=>{
  const f=fixture(t), fake=execDocker();
  const workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const matResult=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute});
  assert.equal(matResult.status,'MATERIALIZED');
  const receipt=probeDockerToolchainV2({
    configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:matResult.materialization,
  },{root:f.root,execute:fake.execute});
  assert.equal(receipt.status,'TOOLCHAIN_VERIFIED'); assert.equal(receipt.trustVerified,true);
  assert.deepEqual(receipt.tools.map(x=>[x.capability,x.executable,x.version]),[['toolchain.node','node','22.16.0']]);
  const execCall=fake.calls.find(argv=>argv.includes('exec'));
  assert.deepEqual(execCall.slice(0,4),['--context','default','exec','--user']);
  assert.ok(execCall.includes(CID)); assert.ok(execCall.includes('node')); assert.ok(!execCall.includes('--test'));
  assert.equal(receipt.containerId,CID); assert.equal(receipt.imageId,IMAGE);
});
test('toolchain v2 refuses untrusted config/workspace before spawning',t=>{
  const f=fixture(t), fake=execDocker();
  const workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const mat=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute}).materialization;
  fake.calls.length=0;
  const config={...f.config,sourceTrustVerified:false};
  const receipt=probeDockerToolchainV2({configuration:config,commandId:'unit',workspaceBinding:workspace,materialization:mat},{root:f.root,execute:fake.execute});
  assert.equal(receipt.status,'HOLD'); assert.equal(receipt.code,'toolchain_v2_prerequisite_missing'); assert.equal(fake.calls.length,0);
});
test('toolchain v2 rejects materialization change after the probe',t=>{
  const f=fixture(t), fake=execDocker();
  const workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const mat=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute}).materialization;
  const reobserve=()=>({status:'MATERIALIZED',materialization:{...mat,imageId:'sha256:'+'f'.repeat(64),observedAt:new Date(1).toISOString()}});
  const receipt=probeDockerToolchainV2({configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:mat},{root:f.root,execute:fake.execute,reobserve});
  assert.equal(receipt.status,'HOLD'); assert.equal(receipt.code,'toolchain_v2_materialization_changed');
});
test('materialization identity ignores observation time but not image/container/config inputs',t=>{
  const f=fixture(t);
  const base={
    schemaVersion:'docker-runner-materialization/v1',runnerId:'tests',runnerSpecDigest:dockerRunnerSpecDigest(f.spec),
    sourceBindingDigest:dockerRunnerSourceBindingDigest(f.binding,{spec:f.spec}),sourceSnapshotSha256:SOURCE,
    daemonId:'daemon:alpha',imageId:IMAGE,configPublicSha256:sha('config'),mountsSha256:sha('mounts'),
    platform:'linux/amd64',containerId:CID,observedAt:new Date(0).toISOString(),
  };
  validateDockerRunnerMaterialization(base,{spec:f.spec,sourceBinding:f.binding});
  const a=dockerRunnerMaterializationIdentityDigest(base,{spec:f.spec,sourceBinding:f.binding});
  const b=dockerRunnerMaterializationIdentityDigest({...base,observedAt:new Date(1).toISOString()},{spec:f.spec,sourceBinding:f.binding});
  assert.equal(a,b);
  assert.notEqual(a,dockerRunnerMaterializationIdentityDigest({...base,configPublicSha256:sha('other')},{spec:f.spec,sourceBinding:f.binding}));
});

test('readiness reaches TOOLCHAIN_READY but never executable before effects/network/secrets gates',t=>{
  const f=fixture(t), fake=execDocker();
  const workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const mat=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute}).materialization;
  const receipt=probeDockerToolchainV2({configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:mat},{root:f.root,execute:fake.execute});
  const ready=evaluateCommandReadiness({configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:mat,toolchainReceipt:receipt});
  assert.equal(ready.status,'TOOLCHAIN_READY');
  assert.equal(ready.sourceTrustVerified,true); assert.equal(ready.policyTrustVerified,true);
  assert.equal(ready.workspaceBindingVerified,true); assert.equal(ready.materializationVerified,true); assert.equal(ready.toolchainVerified,true);
  assert.equal(ready.effectsEnforced,false); assert.equal(ready.networkEnforced,false); assert.equal(ready.secretsResolved,false);
  assert.equal(ready.behaviorAuthorized,false); assert.equal(ready.executableNow,false); assert.equal(ready.qualificationVerdict,null);
});
test('readiness HOLDs if receipt belongs to a different workspace or materialization',t=>{
  const f=fixture(t), fake=execDocker();
  const workspace=bindWorkspaceAuthorityInputs(f.root,f.config);
  const mat=probeDockerRunnerMaterialization({spec:f.spec,sourceBinding:f.binding},{root:f.root,execute:fake.execute}).materialization;
  const receipt=probeDockerToolchainV2({configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:mat},{root:f.root,execute:fake.execute});
  const wrong={...receipt,workspaceBindingDigest:sha('wrong')};
  const ready=evaluateCommandReadiness({configuration:f.config,commandId:'unit',workspaceBinding:workspace,materialization:mat,toolchainReceipt:wrong});
  assert.equal(ready.status,'HOLD'); assert.ok(ready.reasons.includes('toolchain-receipt-invalid')); assert.equal(ready.executableNow,false);
});
