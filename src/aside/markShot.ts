/**
 * 截图标记：以点击位置为圆心做"聚光灯"——整图轻度压暗，留出一个不压暗的亮圆，
 * 圆边加赤陶细环。短评模型靠它知道"点的是哪块区域"。
 *
 * 为什么不是小圆点：真机验证里短评模型 4/4 次把实心点当成界面内容（未读红点/提醒角标）
 * 拿来评；而"标注圈"在模型训练数据里是常见的视觉提示形式，会被正确理解为"给我的标注"。
 * 圆直径取截图逻辑短边的 1/4——罩得住一个典型 UI 块（一条消息/一张卡片），又明显小于半屏。
 *
 * 截图已归一为逻辑像素（主窗口路径主进程归一、deck 路径 normalizeShot 归一），
 * 点击坐标即截图坐标，这里不碰 dpr。解码走 createImageBitmap + canvas，
 * 与 normalizeShot.ts 同一条已踩平的通路。
 */

/**
 * 圆心刻意不做出界 clamp：贴边/角落点击时圆被画布边缘自然裁掉一块，但圆心始终
 * 精确钉在点击点上。平移 clamp 的几何后果是角落点击时点击点距圆心 R√2 > R——
 * 点本身落在圈外，模型会评到圈内相邻区域而非被点元素（角落恰是关闭按钮/角标
 * 这类高频点击物的位置）。模型对"被边缘截断的标注圈"很熟悉，残缺圆无歧义。
 */

/** 在 PNG base64（不带 data: 前缀）的 (x, y) 处画聚光灯标注；失败退回未标记原图——标记不配阻断评点 */
export async function markClickOnScreenshot(
  base64Png: string,
  x: number,
  y: number,
): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(base64Png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d 上下文不可用');
      ctx.drawImage(bitmap, 0, 0);
      const radius = Math.min(bitmap.width, bitmap.height) / 8;
      // 压暗层挖圆洞：矩形 + 圆同 path，evenodd 让圆内不被填充（亮圆即原图，硬边——实现简单优先）。
      // 注意暗色主题截图上压暗几乎不可见，承重的是下面的赤陶环——调标记显著度调环，别调压暗系数
      ctx.beginPath();
      ctx.rect(0, 0, bitmap.width, bitmap.height);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fill('evenodd');
      // 赤陶细环描边：不随主题换色（截图是给模型看的），沿用原点标记的品牌色
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#c45a2b';
      ctx.lineWidth = 3;
      ctx.stroke();
      const dataUrl = canvas.toDataURL('image/png');
      return dataUrl.slice(dataUrl.indexOf(',') + 1);
    } finally {
      bitmap.close();
    }
  } catch {
    return base64Png;
  }
}
