import { useEffect, useState } from "react";

const months = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1).padStart(2, "0"),
  label: new Intl.DateTimeFormat("es-MX", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, index, 1))),
}));

export function MonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [year, setYear] = useState(value.slice(0, 4));
  useEffect(() => setYear(value.slice(0, 4)), [value]);
  return (
    <div
      className="heading-actions"
      role="group"
      aria-label="Periodo de movimientos"
    >
      <select
        className="month-picker"
        aria-label="Mes de los movimientos"
        value={value.slice(5, 7)}
        onChange={(event) =>
          onChange(`${value.slice(0, 4)}-${event.target.value}`)
        }
      >
        {months.map((month) => (
          <option key={month.value} value={month.value}>
            {month.label}
          </option>
        ))}
      </select>
      <input
        className="month-picker"
        type="number"
        min="1"
        max="9999"
        aria-label="Año de los movimientos"
        value={year}
        onChange={(event) => {
          const next = event.target.value;
          setYear(next);
          if (/^\d{4}$/.test(next) && Number(next) > 0)
            onChange(`${next}-${value.slice(5, 7)}`);
        }}
        onBlur={() => {
          if (/^\d{1,4}$/.test(year) && Number(year) > 0) {
            const normalized = year.padStart(4, "0");
            setYear(normalized);
            onChange(`${normalized}-${value.slice(5, 7)}`);
          } else setYear(value.slice(0, 4));
        }}
      />
    </div>
  );
}
