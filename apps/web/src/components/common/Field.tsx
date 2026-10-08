import { inputClass } from "../../styles/shared";

export default function Field({
  name,
  label,
  type = "text",
  minLength,
  maxLength,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  minLength?: number;
  maxLength?: number;
  autoComplete?: string;
}) {
  return (
    <label className="grid min-w-0 gap-2 font-semibold">
      {label}
      <input
        className={inputClass}
        name={name}
        type={type}
        required
        minLength={minLength}
        maxLength={maxLength}
        autoComplete={
          autoComplete ??
          (name === "email" ? "email" : name === "password" ? "current-password" : "off")
        }
      />
    </label>
  );
}
