/**
 * 删到系统回收站的唯一内核——shell.trashItem，抛错不降级永久删（决策 5）。
 *
 * 两条删除路径共用这一处：用户在文件树手动删（fs.trash → mutate.trashEntry）、
 * AI 的 file.write delete（executeFileWriteProposal）。electron 模块在 smoke 进程不可用，
 * 故实现抽成可注入变量；smoke 注入一次，两条路径同时生效。
 */
let trashImpl: (path: string) => Promise<void> = async (path) => {
  const { shell } = await import('electron');
  await shell.trashItem(path); // 抛错不降级永久删（决策 5）
};

/** 仅供 smoke 注入 mock trashItem。 */
export function setTrashItemImplForTest(fn: (path: string) => Promise<void>): void {
  trashImpl = fn;
}

/** 把绝对路径移到系统回收站。抛错不 catch——回收站不可用时不降级永久删。 */
export async function trashPath(absPath: string): Promise<void> {
  await trashImpl(absPath);
}
