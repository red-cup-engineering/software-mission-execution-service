import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Reject lexical escapes and symlink traversal before a software agent reads
 * or writes a declared territory. Nonexistent leaf paths are permitted for
 * authorized creation; existing ancestors are checked from the root down.
 * The executing sandbox still owns concurrent mutation/race protection.
 */
export function insideTerritory(root, requested = ".") {
  const base = resolve(root), path = resolve(base, requested);
  if (path !== base && !path.startsWith(base + sep)) throw new Error("path escapes the admitted territory");
  let cursor = base;
  for (const component of relative(base, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("path traverses a symbolic link in the admitted territory");
  }
  return path;
}
