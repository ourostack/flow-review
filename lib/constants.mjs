export const CHECKS = Object.freeze({
  ui: ['axe', 'keyboard', 'focusVisible', 'contrast', 'targetSize', 'overflow', 'deadSpace', 'repetition', 'cls', 'jank', 'designSystem', 'proofNotice', 'states', 'errors', 'duoOverlap', 'duoReducedMotion', 'duoBytes', 'celebrationCap', 'quietMode'],
  agent: ['exit', 'status', 'jsonShape', 'fields', 'stdoutRules', 'stderrRules', 'text', 'maxMs', 'maxBytes', 'readOnly', 'listed', 'known'],
});

/** Focus guards: the hidden, focusable sentinels focus-trap libraries put at a trap's edges (Base UI, Floating UI, Radix). */
export const FOCUS_GUARDS = Object.freeze(['[data-base-ui-focus-guard]', '[data-floating-ui-focus-guard]', '[data-radix-focus-guard]', '[data-focus-guard]']);

/** Open popup layers (menus, listboxes, dialogs, tooltips, popovers) and the portal roots libraries render them into,
 * outside the page's landmarks on purpose; axe's region rule leaves content inside them out. */
export const POPUP_LAYERS = Object.freeze(['[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]', '[role="tooltip"]', '[popover]', '[data-base-ui-portal]', '[data-radix-popper-content-wrapper]', '[data-radix-portal]']);

export const DEFAULT_THRESHOLDS = Object.freeze({
  axeImpact: 'minor',
  contrastText: 4.5,
  contrastUi: 3,
  targetPx: 24,
  deadSpace: 0.25,
  deadSpaceMinSectionPx: 120,
  repetitionMinChars: 40,
  repetitionMax: 2,
  clsMax: 0.1,
  longTaskMs: 200,
  frameMs: 33,
  slowFrameShare: 0.1,
  overflowPx: 1,
  allowTruncation: false,
  truncationMinShown: 0.5,
  stateMinChars: 20,
  contrastLarge: 3,
  duoBytes: 150 * 1024,
  celebrationMax: 1,
});
