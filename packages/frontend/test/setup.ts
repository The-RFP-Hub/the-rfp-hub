/* jsdom exposes <dialog> but not its modal methods. Node-only suites expose neither. */
if (typeof HTMLDialogElement !== "undefined") {
  if (!("showModal" in HTMLDialogElement.prototype)) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        if (this.open) throw new DOMException("The dialog is already open", "InvalidStateError");
        this.open = true;
      },
    });
  }

  if (!("close" in HTMLDialogElement.prototype)) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement, returnValue = "") {
        if (!this.open) return;
        this.returnValue = returnValue;
        this.open = false;
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      },
    });
  }
}
