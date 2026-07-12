/** Light haptics on actions (when supported). No effect on iOS Safari < 17.4,
 *  but works in the PWA and on most Android devices. */
export function haptic(pattern: number | number[] = 8) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
