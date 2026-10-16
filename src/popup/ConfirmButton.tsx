import { useState, type ReactNode } from "react";

/** Asks for a second click instead of confirm(), whose native dialog is cut off by the popup. */
export function ConfirmButton({
  className,
  onConfirm,
  children,
}: {
  className?: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  let label = children;
  let style = className;
  if (armed) {
    label = "Confirm?";
    style = "contrast";
  }

  return (
    <button
      className={style}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {label}
    </button>
  );
}
