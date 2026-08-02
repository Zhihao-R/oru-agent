/**
 * Deck 画布"骨架"—— 把固定设计稿尺寸缩放进视口、按页显隐 的 CSS / runtime 单一真相源。
 *
 * deck 源文件只写内容(裸 `.slide` + `oru-deck-size` meta),缩放与翻页是"运行时",分两态注入:
 * - **预览态**(在 Oru 里):preload(deckPreview)注入 `deckFrameCss`，缩放由 Oru host 算好推 body
 *   transform、翻页由 host 切 `[data-oru-active]`。源文件不含运行时,故不会和这套叠加。
 * - **分发态**(导出物):exportHtml 把 `deckStandaloneRuntime`(骨架 + 自驱动脚本)内联进产物,
 *   deck 脱离 Oru 也能自己缩放、键盘/点击翻页。
 *
 * 两态共用 `deckFrameCss`(同一套定尺/显隐规则,单一真相源),只是"谁驱动 scale 和翻页"不同——
 * 预览靠 Oru,分发靠 standaloneRuntime。当前页标记两态都用 `[data-oru-active]`,故骨架 CSS 完全共享。
 *
 * 零 node/electron 依赖,故 preload(独立 webContents,编译进 deckPreview.cjs)也能 import——
 * 与 deckModel 同样的约束(认页/取尺寸口径两端必须一致)。
 */

/**
 * 画布骨架 CSS:页面去边距、body 锁定到设计稿尺寸、每页定尺、仅当前页(`[data-oru-active]`)显示。
 * **不含定位 / transform / 背景色**——body 的 position·top·left·transform-origin(预览 static+top-left 配合
 * Oru 坐标模型 / 分发 absolute+center 居中)与 letterbox 底色(预览白 / 分发黑)是两态各自的差异,由调用方补、
 * 不进共享层(否则两端值冲突、要靠拼接顺序覆盖)。
 */
export function deckFrameCss(width: number, height: number): string {
  return `
    html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
    body { width: ${width}px !important; height: ${height}px !important; }
    .slide { display: none !important; width: ${width}px !important; height: ${height}px !important; }
    .slide[data-oru-active] { display: flex !important; }
  `;
}

/**
 * 分发态自包含 runtime(`<style>` 骨架 + `<script>` 自驱动)。**仅导出注入,预览态不用**。
 * - 缩放:`fit()` 按视口算等比 scale,作用在 body(居中:translate(-50%,-50%) + transform-origin center)。
 * - letterbox:窗口比例 ≠ 画布比例时露出 html 底色,用中性黑(投影/全屏演示场景黑边自然)。
 * - 翻页:键盘(方向键/空格/Home/End)+ 点击左右半屏,切 `[data-oru-active]` 并同步 `#/N` hash。
 */
export function deckStandaloneRuntime(width: number, height: number): string {
  return `<style data-oru-runtime-css>
${deckFrameCss(width, height)}
    html { background: #000 !important; height: 100%; }
    body { position: absolute; top: 50%; left: 50%; transform-origin: center center; }
  </style>
<script data-oru-runtime>
(function(){
  var W=${width}, H=${height};
  var slides=Array.from(document.querySelectorAll('.slide'));
  if(!slides.length) return;
  var cur=0;
  function fit(){
    var s=Math.min(window.innerWidth/W, window.innerHeight/H);
    document.body.style.transform='translate(-50%,-50%) scale('+s+')';
  }
  function show(i){
    cur=Math.max(0,Math.min(slides.length-1,i));
    slides.forEach(function(el,idx){ if(idx===cur) el.setAttribute('data-oru-active','1'); else el.removeAttribute('data-oru-active'); });
    try { history.replaceState(null,'','#/'+(cur+1)); } catch(_){} // 同步地址栏不堆历史/不触发 hashchange;file:// 下 Firefox 会抛 SecurityError，吞掉不影响翻页
  }
  window.addEventListener('keydown',function(e){
    if(['ArrowRight','ArrowDown',' ','PageDown'].indexOf(e.key)>=0){e.preventDefault();show(cur+1);}
    else if(['ArrowLeft','ArrowUp','PageUp'].indexOf(e.key)>=0){e.preventDefault();show(cur-1);}
    else if(e.key==='Home'){show(0);} else if(e.key==='End'){show(slides.length-1);}
  });
  document.addEventListener('click',function(e){
    if(e.target.closest && e.target.closest('a')) return;
    if(e.clientX > window.innerWidth*0.62) show(cur+1);
    else if(e.clientX < window.innerWidth*0.38) show(cur-1);
  });
  window.addEventListener('resize',fit);
  var h=parseInt((location.hash.match(/\\/(\\d+)/)||[])[1]||'1',10);
  fit(); show(h-1);
})();
</script>`;
}
