import type { GraphVisualizationDocument } from "../documentTypes";
import { validateGraphVisualizationDocument } from "../schema";

export interface VsCodeApi<State = unknown> {
  getState?(): State | undefined;
  setState(state: State): void;
  postMessage(message: unknown): void;
}

export interface MessageHost {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export async function connectVsCodeBridge(
  api: VsCodeApi<GraphVisualizationDocument>,
  host: MessageHost,
  render: (document: GraphVisualizationDocument) => void,
): Promise<void> {
  host.addEventListener("message", (event) => {
    const message = event.data as { type?: unknown; document?: unknown } | null;
    if (!message || message.type !== "graphDocument") {
      return;
    }
    try {
      const document = validateGraphVisualizationDocument(message.document);
      api.setState(document);
      render(document);
    } catch {
      // Ignore malformed host messages and keep the last valid graph visible.
    }
  });

  const restored = api.getState?.();
  if (restored !== undefined) {
    try {
      render(validateGraphVisualizationDocument(restored));
    } catch {
      // Ignore stale persisted state that no longer matches the graph schema.
    }
  }
  api.postMessage({ type: "ready" });
}
