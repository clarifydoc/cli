/**
 * fast-glob options every walk over the analyzed tree must carry.
 *
 * fast-glob follows symbolic links by default. In a scanned repository that
 * lets a link reach outside the tree (`src/leak.py -> /etc/passwd`, a linked
 * directory), and turns one self-referencing link (`src/loop -> ..`) into
 * every file repeated at each of ~32 nesting levels until the OS refuses the
 * path — exponentially more with two such links. The app server analyzes
 * repositories it cloned from a URL, so both are reachable by whoever controls
 * that repository. A walk that wants a symlinked FILE decides that itself, by
 * resolving it and checking it stays inside the root (see `discoverFiles`).
 */
export const NO_SYMLINKS = { followSymbolicLinks: false } as const;
