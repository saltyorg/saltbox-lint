import * as vscode from "vscode";
import {
  createLiveBounded,
  replaceLiveDocument,
  type LiveBounded,
} from "../support/live-controls.ts";
import type { LiveControlEvidence } from "./live-control-evidence.ts";
import type { LiveOperationName } from "./live-control-vocabulary.ts";

export async function replaceLiveBuffer(
  document: vscode.TextDocument,
  text: string,
  name: LiveOperationName,
  evidence: LiveControlEvidence | undefined,
  bounded: LiveBounded = createLiveBounded(),
): Promise<void> {
  await replaceLiveDocument(document, text, name, evidence, {
    bounded,
    apply: (document, text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        text,
      );
      return vscode.workspace.applyEdit(edit);
    },
  });
}
