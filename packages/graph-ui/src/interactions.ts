import type { GraphVisualizationEdge, GraphVisualizationNode, JsonValue } from "./documentTypes";
import type { DetailsPanel } from "./panel";
import type { GraphViewport } from "./viewport";

export interface RenderedNode {
  element: SVGGElement;
  data: GraphVisualizationNode;
}

export interface RenderedEdge {
  element: SVGLineElement;
  data: GraphVisualizationEdge;
}

interface InteractionOptions {
  svg: SVGSVGElement;
  nodes: RenderedNode[];
  edges: RenderedEdge[];
  viewport: GraphViewport;
  panel: DetailsPanel;
  nodeById: ReadonlyMap<string, GraphVisualizationNode>;
  updateNode(node: RenderedNode): void;
  updateConnectedEdges(nodeId: string): void;
}

interface ActiveDrag {
  node: RenderedNode;
  pointerId: number;
  clientX: number;
  clientY: number;
  moved: boolean;
}

export function installGraphInteractions(options: InteractionOptions): () => void {
  const items: Array<RenderedNode | RenderedEdge> = [...options.nodes, ...options.edges];
  const disposers: Array<() => void> = [];
  const suppressedClicks = new WeakMap<SVGElement, number>();
  const suppressionTimers = new Set<number>();
  let activeDrag: ActiveDrag | undefined;
  let selected: SVGElement | undefined;

  const endDrag = (event?: PointerEvent, captureLost = false): void => {
    if (!activeDrag || (event && event.pointerId !== activeDrag.pointerId)) {
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();
    const { element } = activeDrag.node;
    if (!captureLost && element.hasPointerCapture(activeDrag.pointerId)) {
      element.releasePointerCapture(activeDrag.pointerId);
    }
    if (activeDrag.moved) {
      const timer = window.setTimeout(() => {
        suppressedClicks.delete(element);
        suppressionTimers.delete(timer);
      }, 0);
      suppressedClicks.set(element, timer);
      suppressionTimers.add(timer);
    }
    activeDrag = undefined;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = options.viewport.clientDeltaToGraph(
      event.clientX - activeDrag.clientX,
      event.clientY - activeDrag.clientY,
    );
    activeDrag.clientX = event.clientX;
    activeDrag.clientY = event.clientY;
    activeDrag.moved = activeDrag.moved || delta.dx !== 0 || delta.dy !== 0;
    activeDrag.node.data.x += delta.dx;
    activeDrag.node.data.y += delta.dy;
    options.updateNode(activeDrag.node);
    options.updateConnectedEdges(activeDrag.node.data.id);
  };

  const onPointerUp = (event: PointerEvent): void => endDrag(event);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);

  const setRovingItem = (activeItem: RenderedNode | RenderedEdge): void => {
    for (const item of items) {
      item.element.setAttribute("tabindex", item === activeItem ? "0" : "-1");
    }
  };

  const activate = (item: RenderedNode | RenderedEdge): void => {
    setRovingItem(item);
    selected?.classList.remove("selected");
    selected = item.element;
    selected.classList.add("selected");
    const clearSelected = (): void => {
      item.element.classList.remove("selected");
      if (selected === item.element) {
        selected = undefined;
      }
    };
    if (isRenderedNode(item)) {
      options.panel.open(
        item.data.label,
        detailValues({ Type: item.data.type }, item.data.attributes),
        item.element,
        clearSelected,
      );
      return;
    }
    const source = options.nodeById.get(item.data.source);
    const target = options.nodeById.get(item.data.target);
    options.panel.open(
      item.data.label,
      detailValues(
        {
          Source: source?.label ?? item.data.source,
          Target: target?.label ?? item.data.target,
          Weight: item.data.weight,
        },
        item.data.attributes,
      ),
      item.element,
      clearSelected,
    );
  };

  const focusItem = (index: number): void => {
    const normalized = (index + items.length) % items.length;
    setRovingItem(items[normalized]);
    items[normalized].element.focus();
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    item.element.setAttribute("tabindex", index === 0 ? "0" : "-1");
    const onKeyDown: EventListener = (rawEvent): void => {
      const event = rawEvent as KeyboardEvent;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        focusItem(index + 1);
      } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        focusItem(index - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(item);
      }
    };
    const onClick: EventListener = (rawEvent): void => {
      const event = rawEvent as MouseEvent;
      event.stopPropagation();
      const suppressionTimer = suppressedClicks.get(item.element);
      if (suppressionTimer !== undefined) {
        window.clearTimeout(suppressionTimer);
        suppressionTimers.delete(suppressionTimer);
        suppressedClicks.delete(item.element);
        event.preventDefault();
        return;
      }
      activate(item);
    };
    item.element.addEventListener("keydown", onKeyDown);
    item.element.addEventListener("click", onClick);
    disposers.push(() => {
      item.element.removeEventListener("keydown", onKeyDown);
      item.element.removeEventListener("click", onClick);
    });
  }

  for (const node of options.nodes) {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      endDrag();
      event.preventDefault();
      event.stopPropagation();
      node.element.setPointerCapture(event.pointerId);
      activeDrag = {
        node,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
      };
    };
    const onLostPointerCapture = (event: Event): void => endDrag(event as PointerEvent, true);
    node.element.addEventListener("pointerdown", onPointerDown);
    node.element.addEventListener("lostpointercapture", onLostPointerCapture);
    disposers.push(() => {
      node.element.removeEventListener("pointerdown", onPointerDown);
      node.element.removeEventListener("lostpointercapture", onLostPointerCapture);
    });
  }

  const onBackgroundClick = (event: MouseEvent): void => {
    if (event.target === options.svg) {
      options.panel.close(false);
    }
  };
  options.svg.addEventListener("click", onBackgroundClick);

  return () => {
    endDrag();
    selected?.classList.remove("selected");
    for (const dispose of disposers) {
      dispose();
    }
    options.svg.removeEventListener("click", onBackgroundClick);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    for (const timer of suppressionTimers) {
      window.clearTimeout(timer);
    }
    suppressionTimers.clear();
  };
}

function isRenderedNode(item: RenderedNode | RenderedEdge): item is RenderedNode {
  return "radius" in item.data;
}

function detailValues(
  intrinsic: Readonly<Record<string, JsonValue>>,
  attributes: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = { ...intrinsic };
  for (const [key, value] of Object.entries(attributes)) {
    values[`Attribute: ${key}`] = value;
  }
  return values;
}
