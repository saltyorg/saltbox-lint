interface FailureNode {
  index: number;
  parent?: number;
  relation: "root" | "cause" | "errors";
  name: string;
  message: string;
  code?: string | number;
  phase?: string;
  resource?: string;
  reference?: number;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted]")
    .slice(0, limit);
}

/** Public error fields only; child payload, arguments and environment are omitted. */
export function hostFailureEvidence(error: unknown): {
  nodes: FailureNode[];
  truncated: boolean;
} {
  const nodes: FailureNode[] = [];
  const seen = new Map<object, number>();
  let truncated = false;
  const visit = (
    value: unknown,
    relation: FailureNode["relation"],
    parent: number | undefined,
  ) => {
    if (nodes.length >= 32) {
      truncated = true;
      return;
    }
    const node: FailureNode = {
      index: nodes.length,
      parent,
      relation,
      name: "Non-error value",
      message: "",
    };
    nodes.push(node);
    if (!value || typeof value !== "object") return;
    const reference = seen.get(value);
    if (reference !== undefined) {
      node.name = "Reference";
      node.reference = reference;
      return;
    }
    seen.set(value, node.index);
    if ("name" in value) node.name = text(value.name, 64) ?? "Error";
    if ("message" in value)
      node.message =
        "stdout" in value || "stderr" in value || "argv" in value
          ? "Native operation details omitted"
          : (text(value.message, 256) ?? "");
    if ("code" in value) {
      if (typeof value.code === "string") node.code = text(value.code, 64);
      else if (typeof value.code === "number" && Number.isFinite(value.code))
        node.code = value.code;
    }
    if ("phase" in value) node.phase = text(value.phase, 32);
    if ("resource" in value) node.resource = text(value.resource, 96);
    if ("cause" in value && value.cause !== undefined)
      visit(value.cause, "cause", node.index);
    if ("errors" in value && Array.isArray(value.errors)) {
      if (value.errors.length > 8) truncated = true;
      for (const part of value.errors.slice(0, 8) as unknown[])
        visit(part, "errors", node.index);
    }
  };
  visit(error, "root", undefined);
  return { nodes, truncated };
}

/** Record only after the suite has joined its admitted operations and cleanup. */
export async function withHostFailureEvidence(
  perform: () => Promise<void>,
  write: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  try {
    await perform();
  } catch (error) {
    try {
      write(
        "SALTBOX_EDITOR_FAILURE " + JSON.stringify(hostFailureEvidence(error)),
      );
    } catch (observation) {
      throw new AggregateError(
        [error, observation],
        "Extension host failure evidence could not be recorded",
        { cause: error },
      );
    }
    throw error;
  }
}
