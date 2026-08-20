import { resetActiveView, showLoading } from "./renderer";

export interface GraphToolbarOptions {
  /**
   * Asks the host to send the current graph again. Absent for hosts with no
   * channel back to the producer — the MCP app receives documents through
   * `ontoolresult` and cannot ask for another — where the control stays a
   * view reset and keeps saying so.
   */
  requestRefresh?: () => void;
}

/**
 * Wires the toolbar once per page rather than once per render.
 *
 * The reset handler used to be installed inside `renderDocument`, so it existed
 * only while a graph was on screen: on an empty graph — the exact state a user
 * wants to reload after storing a memory — the button was inert.
 */
export function installGraphToolbar(options: GraphToolbarOptions = {}): () => void {
  const button = document.querySelector<HTMLButtonElement>("#graph-refresh");
  if (!button) {
    return () => {};
  }

  const { requestRefresh } = options;
  if (requestRefresh) {
    button.textContent = "Refresh";
    button.title = "Reload the graph and reset the view";
  }

  const onClick = (): void => {
    resetActiveView();
    if (!requestRefresh) {
      return;
    }
    // The host answers every refresh with a document — the new one, or the
    // unchanged previous one when generation failed — so this indicator always
    // clears on the next render.
    showLoading();
    requestRefresh();
  };

  button.addEventListener("click", onClick);
  return () => button.removeEventListener("click", onClick);
}
