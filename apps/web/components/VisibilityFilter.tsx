import { useEffect, useId, useRef, useState } from "react";

type Props = {
  showIgnored: boolean;
  showDeleted: boolean;
  showKeepFollowing: boolean;
  onIgnoredChange: (checked: boolean) => void;
  onDeletedChange: (checked: boolean) => void;
  onKeepFollowingChange: (checked: boolean) => void;
};

export function VisibilityFilter({
  showIgnored,
  showDeleted,
  showKeepFollowing,
  onIgnoredChange,
  onDeletedChange,
  onKeepFollowingChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count =
    Number(showIgnored) + Number(showDeleted) + Number(showKeepFollowing);

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onOutsideClick);
    return () => document.removeEventListener("pointerdown", onOutsideClick);
  }, [open]);

  return (
    <div
      className="visibility-filter"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`visibility-trigger ${count ? "has-active-filters" : ""}`}
        aria-label={`Visibility filters${count ? `, ${count} active` : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 5h14M3 10h14M3 15h14" />
          <circle cx="7" cy="5" r="2" fill="currentColor" stroke="none" />
          <circle cx="13" cy="10" r="2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="15" r="2" fill="currentColor" stroke="none" />
        </svg>
        Visibility
        {count > 0 && (
          <span className="visibility-count" aria-hidden="true">
            {count}
          </span>
        )}
        <span className="visibility-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          className="visibility-panel"
          role="group"
          aria-label="Visibility options"
        >
          <div className="visibility-panel-heading">
            <strong>Include in list</strong>
            <span>Hidden by default</span>
          </div>
          <label className="visibility-option">
            <input
              type="checkbox"
              checked={showIgnored}
              onChange={(e) => onIgnoredChange(e.target.checked)}
            />
            <span>
              <strong>Ignored accounts</strong>
              <small>Accounts you chose to ignore</small>
            </span>
          </label>
          <label className="visibility-option">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => onDeletedChange(e.target.checked)}
            />
            <span>
              <strong>Marked deleted</strong>
              <small>Personal label, not verified by Instagram</small>
            </span>
          </label>
          <label className="visibility-option">
            <input
              type="checkbox"
              checked={showKeepFollowing}
              onChange={(e) => onKeepFollowingChange(e.target.checked)}
            />
            <span>
              <strong>Keep-following</strong>
              <small>Accounts you marked to keep</small>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
