// Debug output is rendered as plain text, so terminal control sequences must
// be removed as a whole (removing just ESC leaves visible fragments like [36m).
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)/g;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;

export function stripAnsiControlSequences(text: string): string {
  // Strip OSC first so hyperlink destinations and window titles disappear,
  // while the visible hyperlink label remains ordinary text.
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESC_SEQUENCE, "");
}
