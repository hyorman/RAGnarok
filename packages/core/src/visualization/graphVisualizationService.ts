import { MemoryOperationCoordinator } from "../memory/memoryOperationCoordinator";
import { MemoryServiceError } from "../memory/memoryServiceError";
import type { MemoryStore } from "../memory/memoryStore";
import {
  projectMemoryGraphVisualization,
  type GraphVisualizationDocument,
  type GraphVisualizationSource,
} from "./graphVisualization";

export type GraphVisualizationRequest =
  | { scope: "workspace"; maxNodes?: number }
  | { scope: "branch"; branch: string; maxNodes?: number };

export class GraphVisualizationService {
  constructor(
    private readonly store: Pick<MemoryStore, "getGraphSnapshot">,
    private readonly coordinator: MemoryOperationCoordinator,
  ) {}

  async generate(request: GraphVisualizationRequest, signal?: AbortSignal): Promise<GraphVisualizationDocument> {
    signal?.throwIfAborted();
    const branch = request.scope === "branch" ? request.branch.trim() : undefined;
    if (request.scope === "branch" && !branch) {
      throw new MemoryServiceError("MEMORY_INVALID_INPUT", "Branch graph visualization requires a branch");
    }

    try {
      return await this.coordinator.runRead(async () => {
        signal?.throwIfAborted();
        const snapshot = await this.store.getGraphSnapshot(request.scope, branch);
        signal?.throwIfAborted();
        const source: GraphVisualizationSource =
          request.scope === "branch"
            ? { kind: "memory", scope: "branch", branch: branch! }
            : { kind: "memory", scope: "workspace" };
        return projectMemoryGraphVisualization(snapshot, source, { maxNodes: request.maxNodes });
      }, signal);
    } catch (error) {
      if (signal?.aborted === true && error === signal.reason) {
        throw error;
      }
      throw new MemoryServiceError("GRAPH_VISUALIZATION_FAILED", "Unable to generate graph visualization", {
        cause: error,
      });
    }
  }
}
