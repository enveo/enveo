export function StartupSplash() {
  return (
    <div className="startupSplash" role="status" aria-label="Loading Enveo">
      <svg className="startupSplash__art" viewBox="0 0 390 844" aria-hidden="true">
        <g className="startupSplash__beam startupSplash__beam--left">
          <path d="M54 422H146" stroke="#ff7e6b" strokeWidth="6" strokeLinecap="round" />
          <path d="M80 405v34M108 410v24" stroke="#f4efe4" strokeWidth="2" strokeLinecap="round" opacity=".38" />
          <circle cx="54" cy="422" r="5" fill="#ff7e6b" />
        </g>
        <g className="startupSplash__beam startupSplash__beam--right">
          <path d="M244 422H336" stroke="#8fa2cc" strokeWidth="6" strokeLinecap="round" />
          <path d="M282 410v24M310 405v34" stroke="#f4efe4" strokeWidth="2" strokeLinecap="round" opacity=".38" />
          <circle cx="336" cy="422" r="5" fill="#8fa2cc" />
        </g>
        <circle className="startupSplash__ring" cx="195" cy="422" r="57" fill="none" stroke="#f4efe4" strokeWidth="2" opacity=".22" />
        <g className="startupSplash__mark" transform="translate(151.5 378.5) scale(.17)">
          <circle cx="256" cy="256" r="118" fill="none" stroke="#ff7e6b" strokeWidth="58" />
          <line x1="152" y1="256" x2="352" y2="256" stroke="#ff7e6b" strokeWidth="52" />
          <line x1="278" y1="272" x2="424" y2="354" stroke="#1d2a47" strokeWidth="72" />
        </g>
      </svg>
    </div>
  );
}
