export function WaterBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const safeMax = Math.max(1, max);
  const percentage = Math.max(0, Math.min(100, (value / safeMax) * 100));
  return (
    <div
      className="water-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={value}
      style={{ "--value": percentage + "%" } as React.CSSProperties}
    >
      <i />
    </div>
  );
}

export function Progress({
  value,
  total,
  label,
}: {
  value: number;
  total: number;
  label: string;
}) {
  const percentage =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((value / total) * 100)))
      : 0;
  return (
    <div className="readable-progress">
      <div>
        <span>{label}</span>
        <strong>
          {value} de {total}
        </strong>
      </div>
      <WaterBar value={value} max={total} label={label} />
      <small>
        {total ? `${percentage}% completado` : "Sin elementos todavía"}
      </small>
    </div>
  );
}

export function PageGuide({ children }: { children: React.ReactNode }) {
  return <p className="page-guide">{children}</p>;
}
