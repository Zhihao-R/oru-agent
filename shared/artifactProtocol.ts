/**
 * WS 协议消息名集中定义——改名时改这里一处，类型检查兜住所有引用。
 */
export const ARTIFACT_MSG = {
  // ── client → server（请求） ──────────────────────────────────────
  list:              'artifact.list',
  activate:          'artifact.activate',
  adopt:             'artifact.adopt',
  addAnnotation:     'artifact.addAnnotation',
  updateAnnotation:  'artifact.updateAnnotation',
  removeAnnotation:  'artifact.removeAnnotation',
  submitAnnotations: 'artifact.submitAnnotations',
  updateFromNarrative: 'artifact.updateFromNarrative',
  manualFinalize:    'artifact.manualFinalize',
  stopSubmission:    'artifact.stopSubmission',
  saveSubmission:    'artifact.saveSubmission',
  cancelSubmission:  'artifact.cancelSubmission',
  discardInterrupted: 'artifact.discardInterrupted',
  enterCompare:      'artifact.enterCompare',
  exitCompare:       'artifact.exitCompare',
  applyInlineEdit:   'artifact.applyInlineEdit',
  listHistory:       'artifact.listHistory',
  checkoutHistory:   'artifact.checkoutHistory',
  historyPreview:    'artifact.historyPreview',
  export:            'artifact.export',
  undo:              'artifact.undo',
  redo:              'artifact.redo',
  reorderSlides:     'artifact.reorderSlides',
  generateDeck:      'artifact.generateDeck',
  exportCancel:      'artifact.exportCancel',

  // ── server → client（reply） ─────────────────────────────────────
  listResult:              'artifact.list.result',
  adoptResult:             'artifact.adopt.result',
  submitAnnotationsResult: 'artifact.submitAnnotations.result',
  listHistoryResult:       'artifact.listHistory.result',
  checkoutHistoryResult:   'artifact.checkoutHistory.result',
  historyPreviewResult:    'artifact.historyPreview.result',
  exportResult:            'artifact.export.result',
  enterCompareResult:      'artifact.enterCompare.result',

  // ── server → client（broadcast） ────────────────────────────────
  state:              'artifact.state',
  indexChanged:       'artifact.indexChanged',
  annotationsChanged: 'artifact.annotationsChanged',
  submissionChanged:  'artifact.submissionChanged',
  exportProgress:     'artifact.export.progress',
} as const;
