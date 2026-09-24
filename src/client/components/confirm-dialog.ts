/**
 * One reusable confirmation component for every mutation flow in Task 13 that needs an explicit
 * confirmation step (transfer, reversal, expected income, completion, cancellation, override, and
 * baseline-review confirmation all use this rather than six bespoke inline confirmation UIs).
 *
 * Shape decision: this renders an INLINE confirmation panel into a `container` the caller owns
 * (typically a small `<div>` placed right below the button that triggers it), not a `<dialog>` /
 * modal overlay. Reasoning:
 *  - The app is phone-first (spec section 11); an inline panel that pushes the rest of the screen
 *    down reads naturally on a small viewport and needs no focus-trap, backdrop-click-to-close, or
 *    scroll-lock logic to be correctly keyboard- and screen-reader-operable - it's just more
 *    elements in the normal document flow, so Tab order and `:focus-visible` already work for free
 *    with Task 12's existing CSS.
 *  - Every call site already re-renders its whole view body on any state change (the
 *    `createXRenderer(store, api): ViewRenderer` closure pattern), so an inline panel disappears
 *    the same way any other view content does - no separate teardown/portal lifecycle to manage.
 *  - `@testing-library/dom`'s `screen` queries the whole `document`, so inline vs. modal makes no
 *    difference to how the brief's own example test (`click("Save with override")` ->
 *    `button("Confirm override").disabled`) is written.
 *
 * Parameterization: a required `title` + optional `message` (both rendered via textContent - never
 * innerHTML, per the task's money/text-safety constraint), a caller-chosen `confirmLabel` (e.g.
 * "Confirm override", "Confirm transfer"), an optional `reasonLabel` that - when given - adds a
 * labelled text input and keeps confirmLabel's button disabled until it holds non-empty text
 * (exactly the brief's override interaction), and `onConfirm`/`onCancel` callbacks. The confirm
 * button disables itself immediately on click (repeat-submit guard); the caller is responsible for
 * re-enabling it (by re-rendering the panel) if the resulting mutation fails and should be retried.
 */
export interface ConfirmDialogConfig {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** When present, requires a non-empty reason before the confirm button enables. */
  readonly reasonLabel?: string;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel?: () => void;
}

let panelSequence = 0;

/** Renders the confirmation panel into `container`, replacing whatever it currently holds. */
export function renderConfirmDialog(container: HTMLElement, config: ConfirmDialogConfig): void {
  container.replaceChildren();

  const panelId = ++panelSequence;
  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  panel.setAttribute("role", "group");

  const titleId = `confirm-title-${panelId}`;
  const heading = document.createElement("p");
  heading.id = titleId;
  heading.className = "confirm-title";
  heading.textContent = config.title;
  panel.setAttribute("aria-labelledby", titleId);
  panel.appendChild(heading);

  if (config.message) {
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = config.message;
    panel.appendChild(message);
  }

  let reasonInput: HTMLInputElement | null = null;
  if (config.reasonLabel) {
    const field = document.createElement("div");
    field.className = "field";
    const inputId = `confirm-reason-${panelId}`;

    const label = document.createElement("label");
    label.htmlFor = inputId;
    label.textContent = config.reasonLabel;

    reasonInput = document.createElement("input");
    reasonInput.type = "text";
    reasonInput.id = inputId;

    field.append(label, reasonInput);
    panel.appendChild(field);
  }

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "button-primary";
  confirmButton.textContent = config.confirmLabel;
  confirmButton.disabled = Boolean(config.reasonLabel);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button-secondary";
  cancelButton.textContent = config.cancelLabel ?? "Cancel";

  if (reasonInput) {
    const input = reasonInput;
    input.addEventListener("input", () => {
      confirmButton.disabled = input.value.trim().length === 0;
    });
  }

  confirmButton.addEventListener("click", () => {
    if (confirmButton.disabled) return;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    config.onConfirm(reasonInput?.value.trim() ?? "");
  });

  cancelButton.addEventListener("click", () => {
    closeConfirmDialog(container);
    config.onCancel?.();
  });

  actions.append(confirmButton, cancelButton);
  panel.appendChild(actions);
  container.appendChild(panel);
}

/** Clears any confirmation panel previously rendered into `container`. */
export function closeConfirmDialog(container: HTMLElement): void {
  container.replaceChildren();
}
