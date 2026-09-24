import { formatIDR, formatLocalDate } from "../format";
import { renderConfirmDialog, closeConfirmDialog } from "../components/confirm-dialog";
import type { Store } from "../state";
import type { ApiClient, ApiError } from "../api";
import type { IncomeView } from "../../server/view-models";

/**
 * Expected-income management (create, mark received, cancel) - spec sections 9/11 tie expected
 * income directly to `fundedAmount`/`safeToPlanAmount`, both shown on the Plan tab's first
 * viewport. There is no dedicated nav destination for it (the spec's four tabs are
 * Plan/Budgets/Transfers/History), so this is mounted as a section within plan-view.ts rather than
 * getting its own tab. See plan-view.ts for where it's mounted and the full placement rationale.
 *
 * Known limitation (documented, not silently glossed over): `getHistoryRpc` only returns
 * *terminal*-status income (RECEIVED/CANCELLED), and no endpoint lists the currently-CONFIRMED
 * (pending) expected income entries in bulk - `PlanningStateView` doesn't carry them either. Task
 * 13 cannot add a new server endpoint (Task 11's contract is already committed), so "mark
 * received"/"cancel" actions are only offered for entries created earlier in *this browser
 * session* (tracked locally, since a creation's response hands back the entry's actionId). This
 * mirrors the same gap and the same resolution used for plan-view's active-reservation actions.
 */

interface IncomeDraft {
  source: string;
  destinationAccount: string;
  amount: string;
  expectedDate: string;
  note: string;
}

function emptyDraft(): IncomeDraft {
  return { source: "", destinationAccount: "", amount: "", expectedDate: "", note: "" };
}

function describeApiError(error: unknown): string {
  const apiError = error as ApiError;
  return apiError?.message ?? "Something went wrong. Please try again.";
}

export function createExpectedIncomeSection(store: Store, api: ApiClient): (container: HTMLElement) => void {
  let draft = emptyDraft();
  let createActionId = crypto.randomUUID();
  let createPending = false;
  let createError: string | null = null;

  // Entries created (or updated) this session - see the "Known limitation" note above.
  let sessionIncome: IncomeView[] = [];
  const rowPending = new Set<string>();
  const rowErrors = new Map<string, string>();

  let currentContainer: HTMLElement | null = null;

  function rerender(): void {
    if (currentContainer) render(currentContainer);
  }

  function accountOptions(): readonly string[] {
    const accounts = store.getState().bootstrap?.accounts ?? [];
    return accounts.map(a => a.account);
  }

  function submitCreate(event: Event): void {
    event.preventDefault();
    if (createPending) return;
    const amount = Number(draft.amount);
    if (!draft.source.trim() || !draft.destinationAccount || !draft.expectedDate || !Number.isFinite(amount) || amount <= 0) {
      createError = "Enter a source, destination account, positive amount, and expected date.";
      rerender();
      return;
    }
    createPending = true;
    createError = null;
    rerender();

    api
      .createExpectedIncome({
        actionId: createActionId,
        source: draft.source.trim(),
        destinationAccount: draft.destinationAccount,
        amount: amount as never,
        expectedDate: draft.expectedDate as never,
        note: draft.note.trim(),
      })
      .then(({ result, planningState }) => {
        sessionIncome = [result, ...sessionIncome];
        draft = emptyDraft();
        createActionId = crypto.randomUUID();
        createPending = false;
        store.setState({ bootstrap: planningState });
        rerender();
      })
      .catch((error: unknown) => {
        createPending = false;
        createError = describeApiError(error);
        rerender();
      });
  }

  function updateStatus(income: IncomeView, status: "RECEIVED" | "CANCELLED"): void {
    if (rowPending.has(income.actionId)) return;
    rowPending.add(income.actionId);
    rowErrors.delete(income.actionId);
    rerender();

    api
      .updateExpectedIncome({ actionId: income.actionId, status })
      .then(({ result, planningState }) => {
        sessionIncome = sessionIncome.map(entry => (entry.actionId === result.actionId ? result : entry));
        rowPending.delete(income.actionId);
        store.setState({ bootstrap: planningState });
        rerender();
      })
      .catch((error: unknown) => {
        rowPending.delete(income.actionId);
        rowErrors.set(income.actionId, describeApiError(error));
        rerender();
      });
  }

  function render(container: HTMLElement): void {
    currentContainer = container;
    container.replaceChildren();

    const section = document.createElement("section");
    section.className = "expected-income";

    const heading = document.createElement("h2");
    heading.textContent = "Expected income";
    section.appendChild(heading);

    const form = document.createElement("form");
    form.setAttribute("aria-label", "Add expected income");
    form.addEventListener("submit", submitCreate);

    const sourceField = document.createElement("div");
    sourceField.className = "field";
    const sourceLabel = document.createElement("label");
    sourceLabel.htmlFor = "income-source";
    sourceLabel.textContent = "Source";
    const sourceInput = document.createElement("input");
    sourceInput.id = "income-source";
    sourceInput.type = "text";
    sourceInput.value = draft.source;
    sourceInput.addEventListener("input", () => (draft = { ...draft, source: sourceInput.value }));
    sourceField.append(sourceLabel, sourceInput);
    form.appendChild(sourceField);

    const accountField = document.createElement("div");
    accountField.className = "field";
    const accountLabel = document.createElement("label");
    accountLabel.htmlFor = "income-account";
    accountLabel.textContent = "Destination account";
    const accountSelect = document.createElement("select");
    accountSelect.id = "income-account";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select an account";
    accountSelect.appendChild(blank);
    for (const account of accountOptions()) {
      const option = document.createElement("option");
      option.value = account;
      option.textContent = account;
      accountSelect.appendChild(option);
    }
    accountSelect.value = draft.destinationAccount;
    accountSelect.addEventListener("change", () => (draft = { ...draft, destinationAccount: accountSelect.value }));
    accountField.append(accountLabel, accountSelect);
    form.appendChild(accountField);

    const amountField = document.createElement("div");
    amountField.className = "field";
    const amountLabel = document.createElement("label");
    amountLabel.htmlFor = "income-amount";
    amountLabel.textContent = "Income amount";
    const amountInput = document.createElement("input");
    amountInput.id = "income-amount";
    amountInput.type = "number";
    amountInput.min = "1";
    amountInput.value = draft.amount;
    amountInput.addEventListener("input", () => (draft = { ...draft, amount: amountInput.value }));
    amountField.append(amountLabel, amountInput);
    form.appendChild(amountField);

    const dateField = document.createElement("div");
    dateField.className = "field";
    const dateLabel = document.createElement("label");
    dateLabel.htmlFor = "income-date";
    dateLabel.textContent = "Expected date";
    const dateInput = document.createElement("input");
    dateInput.id = "income-date";
    dateInput.type = "date";
    dateInput.value = draft.expectedDate;
    dateInput.addEventListener("input", () => (draft = { ...draft, expectedDate: dateInput.value }));
    dateField.append(dateLabel, dateInput);
    form.appendChild(dateField);

    const noteField = document.createElement("div");
    noteField.className = "field";
    const noteLabel = document.createElement("label");
    noteLabel.htmlFor = "income-note";
    noteLabel.textContent = "Note (optional)";
    const noteInput = document.createElement("input");
    noteInput.id = "income-note";
    noteInput.type = "text";
    noteInput.value = draft.note;
    noteInput.addEventListener("input", () => (draft = { ...draft, note: noteInput.value }));
    noteField.append(noteLabel, noteInput);
    form.appendChild(noteField);

    const submitPanel = document.createElement("div");
    submitPanel.className = "confirm-panel-host";

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "button-primary";
    submitButton.textContent = "Add expected income";
    submitButton.disabled = createPending;
    submitButton.addEventListener("click", () => {
      renderConfirmDialog(submitPanel, {
        title: "Confirm expected income",
        message: `${draft.source || "This income"} will be counted toward this month's funded amount once confirmed.`,
        confirmLabel: "Confirm income",
        onConfirm: () => {
          closeConfirmDialog(submitPanel);
          submitCreate(new Event("submit"));
        },
        onCancel: () => closeConfirmDialog(submitPanel),
      });
    });
    form.appendChild(submitButton);
    form.appendChild(submitPanel);

    if (createError) {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = createError;
      form.appendChild(error);
    }

    section.appendChild(form);

    if (sessionIncome.length > 0) {
      const listHeading = document.createElement("h3");
      listHeading.textContent = "Added this session";
      section.appendChild(listHeading);

      const list = document.createElement("ul");
      for (const income of sessionIncome) {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${formatIDR(income.amount)} from ${income.source} to ${income.destinationAccount} on ${formatLocalDate(income.expectedDate)} - ${income.status}`;
        item.appendChild(text);

        if (income.status === "CONFIRMED") {
          const receivedButton = document.createElement("button");
          receivedButton.type = "button";
          receivedButton.className = "button-secondary";
          receivedButton.textContent = "Mark received";
          receivedButton.disabled = rowPending.has(income.actionId);
          receivedButton.addEventListener("click", () => {
            const panel = document.createElement("div");
            item.appendChild(panel);
            renderConfirmDialog(panel, {
              title: "Confirm income received",
              confirmLabel: "Confirm received",
              onConfirm: () => {
                closeConfirmDialog(panel);
                updateStatus(income, "RECEIVED");
              },
              onCancel: () => closeConfirmDialog(panel),
            });
          });
          item.appendChild(receivedButton);

          const cancelButton = document.createElement("button");
          cancelButton.type = "button";
          cancelButton.className = "button-secondary";
          cancelButton.textContent = "Cancel";
          cancelButton.disabled = rowPending.has(income.actionId);
          cancelButton.addEventListener("click", () => {
            const panel = document.createElement("div");
            item.appendChild(panel);
            renderConfirmDialog(panel, {
              title: "Confirm cancel expected income",
              confirmLabel: "Confirm cancel",
              onConfirm: () => {
                closeConfirmDialog(panel);
                updateStatus(income, "CANCELLED");
              },
              onCancel: () => closeConfirmDialog(panel),
            });
          });
          item.appendChild(cancelButton);
        }

        const rowError = rowErrors.get(income.actionId);
        if (rowError) {
          const error = document.createElement("p");
          error.className = "error-text";
          error.textContent = rowError;
          item.appendChild(error);
        }

        list.appendChild(item);
      }
      section.appendChild(list);
    }

    container.appendChild(section);
  }

  return render;
}
