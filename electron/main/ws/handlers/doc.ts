/**
 * doc.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 doc.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 */
import type { RegistrySlice } from './types';
import { getProject } from '../../projects/store';
import { ensureWithinProject } from '../../fs/projectPath';
import { errMsg } from '../errors';

/**
 * 进行中的 md 文档导出：`projectId:path` → AbortController（与 deck 的 activeExports 分开，两类导出单元
 * 各自一份 map，不靠 key 形态不撞这种巧合）。doc.export 起注册、终态删；doc.exportCancel 据此 abort。
 * 同一文档新导出取代旧导出（见 case doc.export）。
 */
const activeDocExports = new Map<string, AbortController>();

export const docHandlers = {
  'doc.export': async (req, { reply }) => {
    // 镜像 artifact.export，但有本质差异（别当完全同构）：deck 的 HTML 真相源在主进程磁盘 index.html，
    // 主进程自己 readFile；md 导出的 HTML 由渲染端 renderToStaticMarkup 产出、经 req.html 传入——
    // 真相源只活在前端，主进程是纯执行器。后果之一：将来加「对话指令导出」入口时主进程无法独立产出
    // HTML，要么也驱动前端渲染、要么另起一条主进程渲染路径（本期不解决）。
    // 取消按 projectId+path。doc 与 deck 是两类导出单元，各用独立 map（activeDocExports / activeExports）：
    // 不共用一个 Map 靠 key 形态"恰好不撞"——把不撞从巧合变成结构。
    // 同一文档若已有进行中的导出，新请求取代它（abort 旧的）：避免旧 controller 被覆盖后再也取消不掉。
    const key = `${req.projectId}:${req.path}`;
    const controller = new AbortController();
    activeDocExports.get(key)?.abort(); // 取代：旧导出走 catch→cancelled，不落盘
    activeDocExports.set(key, controller);
    try {
      const project = await getProject(req.projectId);
      const docAbs = await ensureWithinProject(project.path, req.path); // 沙箱：导出落点不出项目
      const resolveProjectRoot = async (id: string): Promise<string | null> =>
        (await getProject(id).catch(() => null))?.path ?? null;
      let path: string;
      let missing: string[] = [];
      switch (req.format) {
        case 'html': {
          const { exportDocToHtml } = await import('../../export/exportDocToHtml');
          const r = await exportDocToHtml(docAbs, req.html, resolveProjectRoot);
          path = r.path;
          missing = r.missing; // 缺图不阻断，但回前端附清单（PRD §护栏）
          break;
        }
        case 'pdf': {
          const { exportDocToPdf } = await import('../../export/exportDocToPdf');
          const r = await exportDocToPdf(docAbs, req.html, {
            paperMode: !!req.paperMode,
            signal: controller.signal,
          });
          path = r.path;
          break;
        }
        default: {
          // 穷尽校验：handler 里 req 已窄化到单一 DocExportReq，req.format 在 default 即 never（断言它而非整 req——
          // 整 req 在逐 type handler 签名下不会因 format 穷尽而收窄到 never，这是与原 router 联合 switch 上下文的唯一差异）。
          const _exhaustive: never = req.format;
          throw new Error(`未知导出格式: ${String(_exhaustive)}`);
        }
      }
      const { shell } = await import('electron');
      shell.showItemInFolder(path); // 导出完成在访达打开并选中该文件，用户立刻拿到
      reply(req.reqId, {
        type: 'doc.export.result',
        ok: true,
        path,
        missing: missing.length > 0 ? missing : undefined,
      });
    } catch (e) {
      // abort 也走抛错路径——区分用户取消与真失败，前端据 cancelled 关弹窗不报错。
      const cancelled = controller.signal.aborted;
      reply(req.reqId, {
        type: 'doc.export.result',
        ok: false,
        cancelled,
        message: cancelled ? '已取消导出' : errMsg(e),
      });
    } finally {
      // 仅当 map 里仍是自己这个 controller 才删——被后来的导出取代时不能删掉对方的注册（守卫式 RMW）。
      if (activeDocExports.get(key) === controller) activeDocExports.delete(key);
    }
  },
  'doc.exportCancel': async (req, { reply }) => {
    activeDocExports.get(`${req.projectId}:${req.path}`)?.abort(); // 中断 PDF 离屏渲染；进行中走 catch→cancelled
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
