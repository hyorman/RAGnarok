import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";

const PADDING = 48;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

export interface GraphViewport {
  fit(): void;
  reset(): void;
  clientDeltaToGraph(dx: number, dy: number): { dx: number; dy: number };
  currentScale(): number;
  destroy(): void;
}

export function createViewport(svg: SVGSVGElement, root: SVGGElement): GraphViewport {
  let destroyed = false;
  let mousePanActive = false;
  const behavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .filter(
      (event) =>
        (!event.ctrlKey || event.type === "wheel") &&
        !event.button &&
        !isWithinNode(event.target as EventTarget | null),
    )
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    .extent((): [[number, number], [number, number]] => {
      const { width, height } = viewportSize(svg);
      return [
        [0, 0],
        [width, height],
      ];
    })
    .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      root.setAttribute("transform", event.transform.toString());
    })
    .on("start.viewportLifecycle", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      mousePanActive = event.sourceEvent?.type === "mousedown";
    })
    .on("end.viewportLifecycle", () => {
      mousePanActive = false;
    });

  const selection = select(svg);
  selection.call(behavior);

  const fit = (): void => {
    if (destroyed) {
      return;
    }
    const { width, height } = viewportSize(svg);
    const bounds = graphBounds(root);
    const graphWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const graphHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const availableWidth = Math.max(width - PADDING * 2, 1);
    const availableHeight = Math.max(height - PADDING * 2, 1);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, availableWidth / graphWidth, availableHeight / graphHeight));
    const centerX = bounds.minX / 2 + bounds.maxX / 2;
    const centerY = bounds.minY / 2 + bounds.maxY / 2;
    const transform = zoomIdentity.translate(width / 2 - centerX * scale, height / 2 - centerY * scale).scale(scale);
    selection.call(behavior.transform, transform);
  };

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          fit();
        });
  resizeObserver?.observe(svg);

  return {
    fit,
    reset: fit,
    clientDeltaToGraph(dx, dy) {
      const scale = zoomTransform(svg).k;
      return { dx: dx / scale, dy: dy / scale };
    },
    currentScale() {
      return zoomTransform(svg).k;
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      resizeObserver?.disconnect();
      if (mousePanActive) {
        const view = svg.ownerDocument.defaultView;
        const endMousePan = view ? select<Window, unknown>(view).on("mouseup.zoom") : undefined;
        if (view && endMousePan) {
          endMousePan.call(
            view,
            new view.MouseEvent("mouseup", { view, bubbles: false, cancelable: true, buttons: 0 }),
            undefined,
          );
        }
        mousePanActive = false;
      }
      selection.on(".zoom", null);
    },
  };
}

function isWithinNode(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  const node = candidate?.closest?.(".node");
  return node !== null && node !== undefined;
}

function viewportSize(svg: SVGSVGElement): { width: number; height: number } {
  const rectangle = svg.getBoundingClientRect();
  return {
    width: Math.max(svg.clientWidth || rectangle.width || 1, 1),
    height: Math.max(svg.clientHeight || rectangle.height || 1, 1),
  };
}

function graphBounds(root: SVGGElement): { minX: number; minY: number; maxX: number; maxY: number } {
  const bounds = root.querySelector<SVGRectElement>(".viewport-bounds");
  const x = Number(bounds?.getAttribute("x") ?? 0);
  const y = Number(bounds?.getAttribute("y") ?? 0);
  const authoritative = {
    minX: finiteAttribute(bounds, "data-min-x", x),
    minY: finiteAttribute(bounds, "data-min-y", y),
    maxX: finiteAttribute(bounds, "data-max-x", finiteEnd(x, Number(bounds?.getAttribute("width") ?? 0))),
    maxY: finiteAttribute(bounds, "data-max-y", finiteEnd(y, Number(bounds?.getAttribute("height") ?? 0))),
  };

  if (typeof root.getBBox !== "function") {
    return authoritative;
  }
  const measured = root.getBBox();
  if (![measured.x, measured.y, measured.width, measured.height].every(Number.isFinite)) {
    return authoritative;
  }
  return {
    minX: Math.min(authoritative.minX, measured.x),
    minY: Math.min(authoritative.minY, measured.y),
    maxX: Math.max(authoritative.maxX, finiteEnd(measured.x, measured.width)),
    maxY: Math.max(authoritative.maxY, finiteEnd(measured.y, measured.height)),
  };
}

function finiteAttribute(element: Element | null, name: string, fallback: number): number {
  const raw = element?.getAttribute(name);
  if (raw === null || raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function finiteEnd(start: number, size: number): number {
  const end = start + size;
  return Number.isFinite(end) ? end : size >= 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}
