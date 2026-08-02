/**
 * table.* 命令处理器（D2(a) 迁移域）。
 * 覆盖：xlsx 预览/导入与冲突解决、CSV 打开（超限判定）、视图偏好、xlsx 导出与定位。
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { RegistrySlice } from './types';
import { getProject, getSettings } from '../../projects/store';
import { importXlsxFile, resolveImportConflict } from '../../table/importXlsx';
import { previewXlsxFile } from '../../table/previewXlsx';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import { resolveRendererQuery } from '../../agent/rendererQuery';
import { openCsv } from '../../table/openCsv';
import { buildXlsxFromCsv } from '../../table/exportXlsx';
import { getMainWindow } from '../../window/mainWindowRef';
import { scanProvenance } from '../../table/provenance';
import { ensureWithinProject } from '../../fs/projectPath';
import { readTablePrefs, writeTablePrefs } from '../../fs/tablePrefs';

export const tableHandlers = {
  'table.previewXlsx': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    // 失败文案按 owner 语言取词（主进程 i18n 纪律），渲染层原样显示在预览失败态
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    try {
      const sheets = await previewXlsxFile(project.path, req.path);
      if (sheets.length === 0) {
        reply(req.reqId, {
          type: 'table.xlsxPreview',
          projectId: req.projectId,
          path: req.path,
          sheets: null,
          message: t('main:xlsxPreview.noData', lang),
        });
        return;
      }
      reply(req.reqId, { type: 'table.xlsxPreview', projectId: req.projectId, path: req.path, sheets });
    } catch (e) {
      // 「不存在」与「损坏」拆开：exceljs 对缺文件抛无 code 裸 Error，previewXlsxFile 已先 stat 补齐 code
      const notFound = (e as NodeJS.ErrnoException).code === 'ENOENT';
      reply(req.reqId, {
        type: 'table.xlsxPreview',
        projectId: req.projectId,
        path: req.path,
        sheets: null,
        message: notFound
          ? t('main:xlsxPreview.notFound', lang, { path: req.path })
          : t('main:xlsxPreview.readFailed', lang, { reason: e instanceof Error ? e.message : String(e) }),
      });
    }
  },
  'table.importXlsx': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const outcome = await importXlsxFile(req.projectId, project.path, req.path, broadcast);
    reply(
      req.reqId,
      'failed' in outcome
        ? {
            type: 'table.importResult',
            projectId: req.projectId,
            xlsxPath: req.path,
            sheets: null,
            message: outcome.failed,
          }
        : { type: 'table.importResult', projectId: req.projectId, xlsxPath: req.path, sheets: outcome.sheets },
    );
  },
  'table.resolveImportConflict': async (req, { reply, broadcast }) => {
    const r = await resolveImportConflict(req.conflictId, req.choice, broadcast);
    reply(req.reqId, {
      type: 'table.conflictResolved',
      conflictId: req.conflictId,
      outcome: r.outcome,
      savedAsPath: r.savedAsPath,
    });
  },
  'table.open': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await openCsv(project.path, req.path);
    const provenance = await scanProvenance(project.path, req.path);
    if (!r.overLimit) {
      // 视图偏好随首帧捎带（fileKey=resolve 后的绝对路径，与写入口径一致）；超限只读态无保存场景，不带。
      const fileKey = await ensureWithinProject(project.path, req.path);
      const prefs = await readTablePrefs(fileKey);
      reply(req.reqId, {
        type: 'table.opened',
        projectId: req.projectId,
        path: req.path,
        overLimit: false,
        content: r.content,
        previewRows: null,
        encodingSafe: r.encodingSafe,
        encoding: r.encoding,
        mtimeMs: r.mtimeMs,
        sha256: r.sha256,
        provenance,
        prefs,
      });
    } else {
      reply(req.reqId, {
        type: 'table.opened',
        projectId: req.projectId,
        path: req.path,
        overLimit: true,
        content: null,
        previewRows: r.previewRows,
        encodingSafe: true, // 超限只读态无保存场景，用不到这个判据
        encoding: 'utf-8',
        mtimeMs: r.mtimeMs,
        sha256: null,
        provenance,
        prefs: null, // 超限只读态无保存场景，无偏好——显式 null（与非超限分支同一「无偏好」表达）
      });
      // 总行数读完全文件才知道，异步补报，首屏不等它
      void r
        .countTotalRows()
        .then((totalRows) =>
          broadcast({ type: 'table.rowCount', projectId: req.projectId, path: req.path, totalRows }),
        )
        .catch(() => {});
    }
  },
  'table.prefs.set': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    // fileKey=resolve 后的绝对路径（同 table.open 读取口径）——相对路径直接 hash 会让不同项目同名文件互串。
    const fileKey = await ensureWithinProject(project.path, req.path);
    await writeTablePrefs(fileKey, req.prefs);
    reply(req.reqId, { type: 'ack' });
  },
  'renderer.queryResult': async (req, { reply }) => {
    resolveRendererQuery(req.queryId, req.result);
    reply(req.reqId, { type: 'ack' });
  },
  'table.exportXlsx': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    // 先按点击时的磁盘版编好字节，再弹保存对话框——对话框开着期间 CSV 若被改，导出的仍是点导出那一刻的版本。
    const { buffer, suggestedName } = await buildXlsxFromCsv(project.path, req.path);
    const srcAbs = await ensureWithinProject(project.path, req.path);
    const { dialog } = await import('electron');
    const win = getMainWindow();
    // 默认落在 CSV 同目录（沿用旧的"写到 CSV 旁"便利），但用户可导到任意位置；覆盖由系统对话框确认。
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(dirname(srcAbs), suggestedName),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) {
      reply(req.reqId, { type: 'table.exported', projectId: req.projectId, path: req.path, xlsxPath: null });
      return;
    }
    await fs.writeFile(picked.filePath, buffer);
    reply(req.reqId, { type: 'table.exported', projectId: req.projectId, path: req.path, xlsxPath: picked.filePath });
    // 只有落点在项目内才刷新文件树——导到桌面/下载等项目外位置不影响本项目
    const rel = relative(project.path, picked.filePath);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      broadcast({ type: 'fs.changed', projectId: req.projectId });
    }
  },
  'table.revealExport': async (req, { reply }) => {
    const { shell } = await import('electron');
    shell.showItemInFolder(req.path); // req.path=导出返回的绝对路径；只在访达高亮、不读写内容
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
