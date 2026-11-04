import { useId } from 'react';

/** A transparent signal instrument. Satellites move only while work is live. */
export function SignalOrbit({ state = 'idle', className = '' }) {
  const id = useId().replace(/:/g, '');
  return <svg className={`w-signal ${className}`} data-state={state} viewBox="0 0 160 130" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-silver`} x1="25" y1="15" x2="128" y2="116" gradientUnits="userSpaceOnUse">
        <stop stopColor="var(--w-silver-hi)" /><stop offset=".48" stopColor="var(--w-silver-lo)" /><stop offset="1" stopColor="var(--w-silver-hi)" />
      </linearGradient>
      <linearGradient id={`${id}-core`} x1="-13" y1="-13" x2="13" y2="13" gradientUnits="userSpaceOnUse">
        <stop stopColor="var(--w-core-hi)" /><stop offset="1" stopColor="var(--w-core-lo)" />
      </linearGradient>
    </defs>
    <g className="w-signal__instrument">
      <path className="w-signal__guide" d="M80 9v8m0 96v8M24 65h-8m128 0h-8" strokeWidth="1" />
      <g transform="translate(80 65) rotate(-28) scale(1 .43)">
        <circle r="59" stroke={`url(#${id}-silver)`} strokeWidth="1.3" opacity=".65" />
        <g className="w-signal__satellite w-signal__satellite--one"><circle cx="59" r="4.3" className="w-signal__dot" /><circle cx="59" r="7.5" className="w-signal__halo" /></g>
      </g>
      <g transform="translate(80 65) rotate(38) scale(1 .43)">
        <circle r="52" stroke={`url(#${id}-silver)`} strokeWidth="1.2" opacity=".38" />
        <g className="w-signal__satellite w-signal__satellite--two"><circle cx="52" r="3.8" className="w-signal__dot w-signal__dot--silver" /></g>
      </g>
      <g transform="translate(80 65)">
        <path className="w-signal__brackets" d="M-23-9v-7a7 7 0 0 1 7-7h7m18 0h7a7 7 0 0 1 7 7v7m0 18v7a7 7 0 0 1-7 7H9m-18 0h-7a7 7 0 0 1-7-7V9" strokeWidth="1.2" />
        <rect className="w-signal__core" x="-12" y="-12" width="24" height="24" rx="8" fill={`url(#${id}-core)`} />
        <path className="w-signal__readout" d="M-6 0h3l2-4 3 8 2-4h3" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  </svg>;
}
