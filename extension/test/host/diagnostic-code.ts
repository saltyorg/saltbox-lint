import type * as vscode from "vscode";

// VS Code exposes documentation links as a code object; both forms identify
// the same rule and all existing diagnostic assertions still test its value.
export function diagnosticCode(diagnostic: vscode.Diagnostic) {
  return typeof diagnostic.code === "object"
    ? diagnostic.code.value
    : diagnostic.code;
}
