import type { ManualStatus as ManualStatusValue } from "../lib/api";

export function ManualStatusBadge({ status }: { status: ManualStatusValue }) {
  if (!status) return null;
  return (
    <span
      className={`manual-status-badge ${status === "deleted" ? "manual-status-deleted" : ""}`}
    >
      {status === "deleted"
        ? "Marked deleted by you"
        : "Marked inactive by you"}
    </span>
  );
}

export function ManualStatusControl({
  value,
  onChange,
}: {
  value: ManualStatusValue;
  onChange: (value: ManualStatusValue) => void;
}) {
  return (
    <fieldset className="manual-status-control">
      <legend>Manual account status</legend>
      <p>
        Personal label only. Not verified by Instagram; imported relationship
        facts stay unchanged.
      </p>
      <div className="manual-status-options">
        <label>
          <input
            type="radio"
            name="manual-status"
            checked={value === null}
            onChange={() => onChange(null)}
          />
          <span>Clear status</span>
        </label>
        <label>
          <input
            type="radio"
            name="manual-status"
            checked={value === "inactive"}
            onChange={() => onChange("inactive")}
          />
          <span>Mark inactive</span>
        </label>
        <label>
          <input
            type="radio"
            name="manual-status"
            checked={value === "deleted"}
            onChange={() => onChange("deleted")}
          />
          <span>Mark deleted</span>
        </label>
      </div>
    </fieldset>
  );
}
