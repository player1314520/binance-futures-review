import React from 'react';

export default function MetricCard({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong className="mono">{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
