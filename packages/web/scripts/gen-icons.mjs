// Generuje ikony PWA (PNG) z logo SVG. Uruchom: bun run gen:icons
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = resolve(__dirname, "../public");

const NAVY = "#1d2a47";
const CORAL = "#ff7e6b";

// Mark Enveo: monogram „e" — koralowy okrąg z poprzeczką i wycięciem na granacie.
const mark = `
  <circle cx="256" cy="256" r="118" fill="none" stroke="${CORAL}" stroke-width="58"/>
  <line x1="152" y1="256" x2="352" y2="256" stroke="${CORAL}" stroke-width="52"/>
  <line x1="278" y1="272" x2="424" y2="354" stroke="${NAVY}" stroke-width="72"/>`;

const logo = (radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${radius}" fill="${NAVY}"/>${mark}
</svg>`;

// maskable: pełne tło bez zaokrąglenia + bezpieczny margines (glif skalowany 0.72 wokół środka)
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${NAVY}"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">${mark}</g>
</svg>`;

await mkdir(pub, { recursive: true });

const jobs = [
  ["icon-192.png", logo(116), 192],
  ["icon-512.png", logo(116), 512],
  ["apple-touch-icon.png", logo(0), 180],
  ["icon-maskable-512.png", maskable, 512],
];

for (const [name, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(resolve(pub, name));
  console.log("✓", name);
}
console.log("Ikony wygenerowane.");
