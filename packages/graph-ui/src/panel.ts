import type { JsonValue } from "./documentTypes";

export interface DetailsPanel {
  open(title: string, attributes: Readonly<Record<string, JsonValue>>, invoker: SVGElement, onClose: () => void): void;
  close(restoreFocus?: boolean): void;
  destroy(): void;
}

export function createDetailsPanel(): DetailsPanel {
  const panel = document.querySelector<HTMLElement>("#panel");
  const title = document.querySelector<HTMLElement>("#panel-title");
  const attributes = document.querySelector<HTMLElement>("#panel-attrs");
  const closeButton = document.querySelector<HTMLButtonElement>("#panel-close");
  let invokingItem: SVGElement | undefined;
  let closeCallback: (() => void) | undefined;

  const close = (restoreFocus = true): void => {
    if (panel) {
      panel.hidden = true;
    }
    if (title) {
      title.textContent = "";
    }
    attributes?.replaceChildren();
    const item = invokingItem;
    const callback = closeCallback;
    invokingItem = undefined;
    closeCallback = undefined;
    callback?.();
    if (restoreFocus && item?.isConnected) {
      item.focus();
    }
  };

  const onCloseClick = (): void => close();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && panel && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  closeButton?.addEventListener("click", onCloseClick);
  document.addEventListener("keydown", onKeyDown);

  return {
    open(panelTitle, values, invoker, onClose) {
      close(false);
      invokingItem = invoker;
      closeCallback = onClose;
      if (title) {
        title.textContent = panelTitle;
      }
      if (attributes) {
        for (const [key, value] of Object.entries(values)) {
          const term = document.createElement("dt");
          term.textContent = key;
          const description = document.createElement("dd");
          description.textContent = formatValue(value);
          attributes.append(term, description);
        }
      }
      if (panel) {
        panel.hidden = false;
      }
      closeButton?.focus();
    },
    close,
    destroy() {
      close(false);
      closeButton?.removeEventListener("click", onCloseClick);
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}

export function resetPanel(): void {
  const panel = document.querySelector<HTMLElement>("#panel");
  if (panel) {
    panel.hidden = true;
  }
  const title = document.querySelector<HTMLElement>("#panel-title");
  if (title) {
    title.textContent = "";
  }
  document.querySelector("#panel-attrs")?.replaceChildren();
}

function formatValue(value: JsonValue): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}
