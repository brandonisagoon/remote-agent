export class AccountingObserverUnavailable extends Error {
  constructor(readonly code: "ACCOUNTING_OBSERVER_REQUIRED" | "ACCOUNTING_OBSERVER_CHANGED") {
    super(code === "ACCOUNTING_OBSERVER_REQUIRED"
      ? "Original accounting checker is unavailable; inspect this group's retained inputs for explicit owner adoption"
      : "The adopted accounting checker or its original input changed; inspect the existing adoption before retrying");
  }
}
