import './__smoke_isolate__';
import { getBackendFor } from '../../electron/main/agent/backends';
import { listAgents } from '../../electron/main/agent/store/agents';
import { runDream } from '../../electron/main/memory/dream';
import { debugLogger } from '../../electron/main/debug/logger';
import { readMarkdownFile } from '../../electron/main/fs/frontmatter';
import { userProfilePath } from '../../electron/main/memory/paths';
const OWNER='local-user';
export async function run(){
  if(!process.env.ORU_DIR||!process.env.ORU_DIR.endsWith('/.oru')) throw new Error('ORU_DIR bad');
  // 诊断脚本必须留下事件流：debugLogger 默认关（生产由 settings.developer.debugLogging 打开），
  // 这条路径不经主进程启动期那次注入，不显式开就只剩一句 outcome、看不到它调了什么工具。
  debugLogger.setEnabled(true);
  const {agents}=await listAgents(); const agent=agents.find(a=>a.ownerId===OWNER); if(!agent) throw new Error('no agent');
  const backend=await getBackendFor('memoryDream'); const ready=await backend.isReady(); if(!ready.ok) throw new Error('backend not ready:'+ready.hint);
  const before=(await readMarkdownFile(userProfilePath(OWNER)))?.content??''; console.log('=== BEFORE ===\n'+before);
  const outcome=await runDream({ownerId:OWNER,currentProjectId:null}); console.log('=== OUTCOME ===\n'+JSON.stringify(outcome));
  const after=(await readMarkdownFile(userProfilePath(OWNER)))?.content??''; console.log('=== AFTER ===\n'+after);
}
