import { useTheme } from "./contexts";
import { msg, type Message } from "./i18n";

/** A set of hand-drawn stroke SVG icons (24×24). From the prototype. */
export const ICONS: Record<string, string[]> = {
  briefcase: ["M3 8h18v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8z", "M8 8V6a2 2 0 012-2h4a2 2 0 012 2v2"],
  card: ["M3 6.5h18v11H3z", "M3 10h18"],
  rocket: [
    "M5 15c-1.3 1.1-1.7 4.2-1.7 4.2s3.1-.4 4.2-1.7c.6-.7.6-1.8-.1-2.4a1.8 1.8 0 00-2.4-.1z",
    "M12.5 13.5l-2.5-2.5a18 18 0 011.7-3.3A10.7 10.7 0 0119.5 3.5c0 2.3-.6 6.2-5 9.2a18 18 0 01-3.3 1.7z",
  ],
  wallet: ["M20 12V7.5H5a2 2 0 010-4h13v4", "M3 5.5v13a2 2 0 002 2h15v-4", "M17.5 12a1.8 1.8 0 000 3.5H21V12z"],
  safe: ["M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z", "M11.5 9a3 3 0 103 3", "M16.5 4.5v15"],
  scales: ["M12 3v18", "M5 8h14", "M8 8l-3 6a3 3 0 006 0L8 8z", "M16 8l-3 6a3 3 0 006 0l-3-6z"],
  receipt: ["M5.5 3h13v18l-2.2-1.3-2.1 1.3-2.2-1.3-2.1 1.3-2.2-1.3V3z", "M9 8h6", "M9 12h6", "M9 16h4"],
  moneybag: ["M9.5 3.5h5l-1 2.4a5.5 5.5 0 11-3 0L9.5 3.5z", "M12 11v4", "M10.3 12.8h3.4"],
  laptop: ["M4 5.5h16v9.5H4z", "M2.5 19h19", "M9.5 19l.4-2.5h4.2l.4 2.5"],
  house: ["M3 11l9-7.5 9 7.5", "M5.5 10v10h13V10", "M10 20v-5.5h4V20"],
  play: ["M4 5.5h16v13H4z", "M10 9.5l5 3-5 3z"],
  car: ["M5 13l1.6-5.2A2 2 0 018.5 6.4h7a2 2 0 011.9 1.4L19 13", "M4 13h16v4.5a1 1 0 01-1 1H5a1 1 0 01-1-1V13z", "M7.5 15.5h.5", "M16 15.5h.5"],
  paw: [
    "M8.5 9.5a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z",
    "M15.5 9.5a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z",
    "M6 13.5a1.3 1.3 0 100-2.6 1.3 1.3 0 000 2.6z",
    "M18 13.5a1.3 1.3 0 100-2.6 1.3 1.3 0 000 2.6z",
    "M12 19.5c2.4 0 4-1.5 4-3.2 0-1.4-1.6-2.3-4-2.3s-4 .9-4 2.3c0 1.7 1.6 3.2 4 3.2z",
  ],
  heart: ["M20.5 6.8a4.4 4.4 0 00-7.2-1.4L12 6.7l-1.3-1.3A4.4 4.4 0 003.5 8.5c0 .9.3 1.7 1 2.4", "M3 12.5h4l1.5-2.5 2.5 5 2-3h6.5"],
  gift: ["M19.5 12v8.5h-15V12", "M3 7.5h18V12H3z", "M12 7.5v13", "M12 7.5S9.6 3.6 7.2 4.8C5.4 5.7 9 7.5 12 7.5z", "M12 7.5s2.4-3.9 4.8-2.7C18.6 5.7 15 7.5 12 7.5z"],
  person: ["M12 11.5a3.4 3.4 0 100-6.8 3.4 3.4 0 000 6.8z", "M5 20v-.5a7 7 0 0114 0V20"],
  people: ["M9 11a3 3 0 100-6 3 3 0 000 6z", "M2.5 19.5a6.5 6.5 0 0113 0", "M16 5.2a3 3 0 011.8 5.6", "M16.5 12.8a6 6 0 015 5.5"],
  tag: ["M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3.5h9.5l8.1 8.1a2 2 0 010 2.8z", "M7.5 7.5h.5"],
  plane: ["M21 15.5v-1.6l-7.5-4.7V4a1.5 1.5 0 00-3 0v5.2L3 13.9v1.6l7.5-2.3V18l-1.8 1.4v1.2l3.3-.9 3.3.9v-1.2L13.5 18v-2.8L21 15.5z"],
  food: ["M7 3.2v4.3", "M7 7.5c-1 0-1.6-.6-1.6-2.1V3.2", "M7 7.5c1 0 1.6-.6 1.6-2.1V3.2", "M7 7.5v13.3", "M16 3.2c-1.4 0-2 2-2 4.4 0 2.1.6 3.3 2 3.3", "M16 3.2v17.6"],
  dots: ["M5 12h.4", "M12 12h.4", "M19 12h.4"],

  /* ── Rozszerzenie biblioteki (v1.20): glify do pickera kont/kopert ── */
  banknote: ["M3 7h18v10H3z", "M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z", "M6 12h.4", "M17.6 12h.4"],
  coins: ["M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3z", "M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5", "M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  piggy: ["M12 5.5c4.2 0 7.5 2.7 7.5 6.1 0 3.4-3.3 6.1-7.5 6.1S4.5 15 4.5 11.6 7.8 5.5 12 5.5z", "M9.8 5.8L9.4 4h5.2l-.4 1.8", "M8 17.4l-.4 2", "M16 17.4l.4 2", "M15.6 10.4h.4"],
  cart: ["M3 4.5h2l2.2 11h11.3l2-8H6.2", "M9.2 20a1 1 0 100-2 1 1 0 000 2z", "M17 20a1 1 0 100-2 1 1 0 000 2z"],
  shopbag: ["M5 8h14l-1 12.5H6L5 8z", "M9 10.5V6.5a3 3 0 016 0v4"],
  store: ["M4.5 9L5.7 4.5h12.6L19.5 9", "M4 9a2.6 2.6 0 005.3 0 2.65 2.65 0 005.4 0A2.6 2.6 0 0020 9", "M5.5 11.5v9h13v-9", "M9.5 20.5v-5h5v5"],
  percent: ["M6 18L18 6", "M7.5 9.5a2 2 0 100-4 2 2 0 000 4z", "M16.5 18.5a2 2 0 100-4 2 2 0 000 4z"],
  building: ["M5 20.5V4h10v16.5", "M15 9h4v11.5", "M3.5 20.5h17", "M8 7.5h.4", "M11.5 7.5h.4", "M8 11h.4", "M11.5 11h.4", "M8 14.5h.4", "M11.5 14.5h.4"],
  sofa: ["M5.5 11V8.5a3 3 0 013-3h7a3 3 0 013 3V11", "M3.5 13.5a2 2 0 014 0v.5h9v-.5a2 2 0 014 0c0 1-.6 1.8-1.5 2v2.5h-14v-2.5c-.9-.2-1.5-1-1.5-2z"],
  bed: ["M4 19.5v-6a2 2 0 012-2h12a2 2 0 012 2v6", "M4 17h16", "M6.5 11.5V8.5h4.5v3"],
  lamp: ["M9 3.5h6l3.2 8.5H5.8L9 3.5z", "M12 12v8.5", "M8.5 20.5h7"],
  bolt: ["M13 2.5L5 13.5h5.5L10 21.5l8-11h-5.5L13 2.5z"],
  drop: ["M12 3.5s6 6.2 6 10.2a6 6 0 11-12 0c0-4 6-10.2 6-10.2z"],
  flame: ["M12 3.5c1 2.8 4.5 4.6 4.5 8.6a4.5 4.5 0 01-9 0c0-1.5.5-2.7 1.3-3.9.4 1 .9 1.6 1.7 2.1-.2-2.6.3-5 1.5-6.8z"],
  wifi: ["M4 9.5a11.5 11.5 0 0116 0", "M7 13a7.5 7.5 0 0110 0", "M10 16.2a3.5 3.5 0 014 0", "M12 19.3h.3"],
  phone: ["M7 2.5h10v19H7z", "M11 18.8h2"],
  trash: ["M4.5 6.5h15", "M8 6.5V4.8a1.3 1.3 0 011.3-1.3h5.4A1.3 1.3 0 0116 4.8v1.7", "M6.5 6.5l1 14h9l1-14", "M10.5 10.5v6", "M13.5 10.5v6"],
  coffee: ["M5 8.5h11v6a5 5 0 01-5 5h-1a5 5 0 01-5-5v-6z", "M16 10h1.7a2.3 2.3 0 010 4.6H16", "M8 5.5c0-1 .8-1 .8-2", "M11.5 5.5c0-1 .8-1 .8-2"],
  pizza: ["M4 5.5a17 17 0 0116 0L12 21 4 5.5z", "M4.8 7.3a15 15 0 0114.4 0", "M10 10.5h.4", "M13.5 13.5h.4", "M11 16.5h.4"],
  burger: ["M4.5 9.5a7.5 5 0 0115 0v.5h-15v-.5z", "M4 12.5h16", "M5 15.5h14v1a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 015 16.5v-1z"],
  apple: ["M12 7.5c-1-.8-2.4-1.2-3.7-.7C5.9 7.7 5 10.4 5.8 13.2c.8 2.9 2.8 5.6 4.7 5.3.6-.1 1-.4 1.5-.4s.9.3 1.5.4c1.9.3 3.9-2.4 4.7-5.3.8-2.8-.1-5.5-2.5-6.4-1.3-.5-2.7-.1-3.7.7z", "M12 7.5c0-2 1.3-3.3 3-3.5"],
  carrot: ["M14.7 9.3c1.7 1.7 1 4.3-1.4 6.7-2.4 2.4-7 4.8-8.3 3.5S6.1 13 8.5 10.6s4.5-3 6.2-1.3z", "M14.7 9.3L18 6", "M14 5.2l.7 4.1 4.1.7"],
  wine: ["M7 3.5h10c0 4-1.5 7-5 7s-5-3-5-7z", "M12 10.5v8", "M8.5 20.5h7"],
  beer: ["M6 5.5h9v15H6z", "M15 9h2.5a1.5 1.5 0 011.5 1.5v4a1.5 1.5 0 01-1.5 1.5H15", "M9 9v8", "M12 9v8"],
  cake: ["M5 12h14v8.5H5z", "M5 15.5c1.2 0 1.2 1 2.3 1s1.2-1 2.3-1 1.2 1 2.4 1 1.1-1 2.3-1 1.2 1 2.3 1 1.2-1 2.4-1", "M12 12V8.5", "M12 6a1.2 1.2 0 001.2-1.2c0-.8-1.2-2-1.2-2s-1.2 1.2-1.2 2A1.2 1.2 0 0012 6z"],
  bus: ["M4.5 5a2 2 0 012-2h11a2 2 0 012 2v13h-15V5z", "M4.5 11.5h15", "M7.5 15h.4", "M16.1 15h.4", "M6.5 18v2h2.5v-2", "M15 18v2h2.5v-2"],
  bike: ["M6 18.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z", "M18 18.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z", "M6 15l3.5-7 3.5 7H6z", "M13 8h2l3 7", "M9.5 8H7"],
  fuel: ["M5 20.5V5a1.5 1.5 0 011.5-1.5h5A1.5 1.5 0 0113 5v15.5", "M4 20.5h10", "M6.5 6.5h4v4h-4z", "M13 12h1.5a2 2 0 012 2v3a1.5 1.5 0 003 0v-7L17 7.5"],
  train: ["M5.5 3.5h13v13.5h-13z", "M5.5 10h13", "M9 14.5h.3", "M14.7 14.5h.3", "M7.5 20.5L9 17", "M16.5 20.5L15 17"],
  pill: ["M13.4 3.9a4.3 4.3 0 016.1 6.1l-6.8 6.8a4.3 4.3 0 01-6.1-6.1l6.8-6.8z", "M10 7.3l6.1 6.1"],
  medkit: ["M4 7.5h16v12H4z", "M9 7.5V6a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 6v1.5", "M12 10.5v6", "M9 13.5h6"],
  dumbbell: ["M2.5 12h1.5", "M20 12h1.5", "M4 8.5h3v7H4z", "M17 8.5h3v7h-3z", "M7 12h10"],
  flower: ["M12 20.5c-5 0-8.5-3.5-8.5-8.5 5 0 8.5 3.5 8.5 8.5z", "M12 20.5c5 0 8.5-3.5 8.5-8.5-5 0-8.5 3.5-8.5 8.5z", "M12 13V3.5"],
  scissors: ["M6 8.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z", "M6 20.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z", "M20 5L8.1 16.9", "M14.5 14.5l5.5 5.4", "M8.1 7.1L12 11"],
  music: ["M6.5 20.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z", "M16.5 18.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z", "M9 18V5.5l10-2V16"],
  gamepad: ["M7 8.5h10a5 5 0 015 5 3 3 0 01-5.3 1.9L15 13.5H9l-1.7 1.9A3 3 0 012 13.5a5 5 0 015-5z", "M8 10.5v2.6", "M6.7 11.8h2.6", "M15.8 10.8h.4", "M17.8 12.8h.4"],
  book: ["M4.5 19.5A2.5 2.5 0 017 17h12.5", "M7 2.5h12.5V21H7a2.5 2.5 0 01-2.5-2.5v-13A2.5 2.5 0 017 2.5z"],
  camera: ["M4 7.5h3l1.5-2h7l1.5 2h3v11H4v-11z", "M12 16a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"],
  ticket: ["M3.5 7h17v3.2a2 2 0 000 4V17h-17v-2.8a2 2 0 000-4V7z", "M14.5 9.5v1", "M14.5 13.5v1"],
  graduation: ["M2.5 9L12 4.5 21.5 9 12 13.5 2.5 9z", "M6.5 11v4.5c1.5 1.3 3.4 2 5.5 2s4-.7 5.5-2V11", "M21.5 9v4.5"],
  baby: ["M12 20.5a8 8 0 110-16 8 8 0 010 16z", "M9.5 14s.9 1 2.5 1 2.5-1 2.5-1", "M9.5 10.5h.4", "M14.1 10.5h.4", "M12 4.5c0-1.2.8-2 1.8-2"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.7-5.3 2.7 1-5.8-4.2-4.1 5.9-.9L12 3.5z"],
  umbrella: ["M12 3.5a9 9 0 00-9 9h18a9 9 0 00-9-9z", "M12 12.5v6a2 2 0 004 0"],
  globe: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M3 12h18", "M12 3c2.5 2.3 4 5.5 4 9s-1.5 6.7-4 9c-2.5-2.3-4-5.5-4-9s1.5-6.7 4-9z"],
  calendar: ["M4.5 5.5h15v15h-15z", "M4.5 9.5h15", "M8 3.5v3.5", "M16 3.5v3.5", "M8 13h.4", "M12 13h.4", "M15.6 13h.4"],
  shield: ["M12 3l7.5 3v6c0 4.5-3 7.8-7.5 9.5C7.5 19.8 4.5 16.5 4.5 12V6L12 3z"],
  leaf: ["M19.5 4.5C10.5 5 5.5 10 5.5 19c9 0 14-5 14-14.5z", "M4.5 19.5C8 15 12 11.5 16.5 8"],
  envelope: ["M3.5 5.5h17v13h-17z", "M3.5 6.5L12 13l8.5-6.5"],
};

/** Icon picker categories (order = section order). "dots" = UI, outside the picker. */
export const ICON_CATEGORIES: Array<{ label: Message; icons: string[] }> = [
  { label: msg("Finance & shopping"), icons: ["wallet", "card", "banknote", "coins", "piggy", "safe", "moneybag", "receipt", "cart", "shopbag", "store", "percent", "scales", "briefcase", "tag"] },
  { label: msg("Home & bills"), icons: ["house", "building", "sofa", "bed", "lamp", "bolt", "drop", "flame", "wifi", "phone", "trash"] },
  { label: msg("Food & drink"), icons: ["food", "coffee", "pizza", "burger", "apple", "carrot", "wine", "beer", "cake"] },
  { label: msg("Transport"), icons: ["car", "bus", "bike", "fuel", "train", "plane"] },
  { label: msg("Health & fitness"), icons: ["heart", "pill", "medkit", "dumbbell", "flower", "scissors"] },
  { label: msg("Leisure & learning"), icons: ["play", "music", "gamepad", "book", "camera", "ticket", "laptop", "rocket", "graduation", "gift"] },
  { label: msg("People & pets"), icons: ["person", "people", "baby", "paw"] },
  { label: msg("Other"), icons: ["star", "umbrella", "globe", "calendar", "shield", "leaf", "envelope"] },
];

/** Install glyph (arrow into a tray) — ONE home; drawn by the Drawer row and the Settings hub card. */
export const D_INSTALL = "M12 4v10 M8 10l4 4 4-4 M5 20h14";

export function Glyph({ name, size = 20, color, sw = 1.7 }: { name: string; size?: number; color: string; sw?: number }) {
  const paths = ICONS[name] ?? ICONS.wallet!;
  // stroke via style, not an attribute — var(--accent) etc. does not work in SVG presentation attributes.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ stroke: color }} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function Ico({ d, size = 18, color, sw = 1.7 }: { d: string; size?: number; color?: string; sw?: number }) {
  const C = useTheme();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ stroke: color ?? C.soft }} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
