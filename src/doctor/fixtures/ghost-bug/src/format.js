import { defaultOptions } from "./config.js";

// Format a label with optional overrides, e.g. format("ok") -> "[ ok ]".
//
// GHOST BUG: `Object.assign(defaultOptions, options)` MUTATES the shared default object from config.js.
// The first call with custom options permanently corrupts the defaults for every later default call.
// The unit suite is green because it never formats with defaults AFTER a custom call — the bug is
// latent, surfacing only via call interaction. Fix = a non-mutating merge: Object.assign({}, defaultOptions, options).
export function format(label, options = {}) {
  const opts = Object.assign(defaultOptions, options);
  const p = " ".repeat(opts.pad);
  return `${opts.prefix}${p}${label}${p}${opts.suffix}`;
}
