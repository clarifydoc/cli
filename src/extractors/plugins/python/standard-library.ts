/**
 * Python's standard library, as the top-level modules an import names
 * (`sys.stdlib_module_names` without the private `_x` ones and the toys).
 * Modules removed in later versions stay: old code still imports them.
 * Leaf code: the static manifest uses it.
 */
const STANDARD_MODULES = new Set([
  "__future__", "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio", "asyncore", "atexit", "audioop",
  "base64", "bdb", "binascii", "bisect", "builtins", "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath",
  "cmd", "code", "codecs", "codeop", "collections", "colorsys", "compileall", "concurrent", "configparser",
  "contextlib", "contextvars", "copy", "copyreg", "crypt", "csv", "ctypes", "curses", "dataclasses", "datetime", "dbm",
  "decimal", "difflib", "dis", "distutils", "doctest", "email", "encodings", "ensurepip", "enum", "errno",
  "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools", "gc", "getopt",
  "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib",
  "imghdr", "imp", "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword", "lib2to3", "linecache",
  "locale", "logging", "lzma", "mailbox", "mailcap", "marshal", "math", "mimetypes", "mmap", "modulefinder", "msilib",
  "msvcrt", "multiprocessing", "netrc", "nis", "nntplib", "ntpath", "numbers", "opcode", "operator", "optparse", "os",
  "ossaudiodev", "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform", "plistlib", "poplib",
  "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc", "pyexpat",
  "queue", "quopri", "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets",
  "select", "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtpd", "smtplib", "sndhdr", "socket",
  "socketserver", "spwd", "sqlite3", "sre_compile", "sre_constants", "sre_parse", "ssl", "stat", "statistics",
  "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys", "sysconfig", "syslog", "tabnanny",
  "tarfile", "telnetlib", "tempfile", "termios", "textwrap", "threading", "time", "timeit", "tkinter", "token",
  "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle", "types", "typing", "unicodedata",
  "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave", "weakref", "webbrowser", "winreg", "winsound",
  "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib", "zoneinfo",
]);

/**
 * Whether `import <source>` in `importingFile` loads the standard library.
 *
 * Python looks a top-level module up on `sys.path`, whose first entry is the
 * directory of the script being run, before the standard library: a project
 * module of the same name there shadows it. Only a directory that is not a
 * package (no `__init__.py`) can be such an entry, so the importer's own
 * ancestors are tried up to the root, skipping packages — `league/types.py`
 * inside the package `league` is `league.types`, never `types`; a
 * `calendar/` app beside `manage.py` is the `calendar` a Django view imports.
 */
export function pythonStandardImport(importingFile: string, source: string, hasFile: (path: string) => boolean): boolean {
  if (source.startsWith(".")) return false;
  const top = source.split(".")[0]!;
  if (!STANDARD_MODULES.has(top)) return false;
  const join = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);
  let dir = importingFile.includes("/") ? importingFile.slice(0, importingFile.lastIndexOf("/")) : "";
  for (;;) {
    if (!hasFile(join(dir, "__init__.py")) || dir === "") {
      if (hasFile(join(dir, `${top}.py`)) || hasFile(join(dir, `${top}/__init__.py`))) return false;
    }
    if (dir === "") return true;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}
