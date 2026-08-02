/**
 * HTML 标注提交 WS 消息名（项目B 第三期 Task14）——与 artifact.*（deck）对称、keyed by htmlPath。
 *
 * html 不套 artifactId、不走 deck 体检：每条消息带 htmlPath，handler 解析 htmlTarget(htmlPath)
 * 喂共用提交内核（submitAnnotationsTo / finalizeSubmission / *For(target)）。事件单独走 html.*——
 * 不能复用 deck onArtifactSubmissionChanged（其内 readAnnotations(artifactId) 是 deck 适配器、html 会抛）。
 */
export const HTML_MSG = {
  // ── client → server（请求） ──────────────────────────────────────
  activate:           'html.activate',
  addAnnotation:      'html.addAnnotation',
  updateAnnotation:   'html.updateAnnotation',
  removeAnnotation:   'html.removeAnnotation',
  submitAnnotations:  'html.submitAnnotations',
  manualFinalize:     'html.manualFinalize',
  stopSubmission:     'html.stopSubmission',
  saveSubmission:     'html.saveSubmission',
  cancelSubmission:   'html.cancelSubmission',
  discardInterrupted: 'html.discardInterrupted',
  enterCompare:       'html.enterCompare',
  exitCompare:        'html.exitCompare',

  // ── server → client（reply） ─────────────────────────────────────
  activateResult:          'html.activate.result',
  submitAnnotationsResult: 'html.submitAnnotations.result',
  enterCompareResult:      'html.enterCompare.result',

  // ── server → client（broadcast） ────────────────────────────────
  indexChanged:       'html.indexChanged',
  annotationsChanged: 'html.annotationsChanged',
  submissionChanged:  'html.submissionChanged',
} as const;
