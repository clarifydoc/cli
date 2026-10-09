import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { pascalFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const pascalManifest: LanguagePluginManifest = {
  language: "pascal",
  family: "pascal",
  parsing: "tree-sitter",
  extensions: [".pas", ".pp", ".lpr", ".dpr", ".dpk"],
  // Delphi/Pascal is case-insensitive: `_repo.save` calls the declared `Save`.
  caseInsensitiveNames: true,
  // `uses WaitForm;` puts the unit's interface routines in scope unqualified:
  // a bare `ShowWaitForm(…)` is the one used unit that declares it.
  importsShareScope: true,
  // `TfrmLaerer.Create(AOwner)` runs the constructor (reported as `constructor`).
  constructorCalls: ["Create"],
  grammar: { variants: { pascal: { pkg: "tree-sitter-pascal", wasm: "tree-sitter-pascal.wasm" } } },
  externalModulePrefixes: [
    // Unit-scope roots (dotted namespaces, Delphi XE2+). Canonical IDE casing.
    "System.", "Vcl.", "FMX.", "Data.", "Datasnap.", "DataSnap.", "EMS.",
    "Winapi.", "Posix.", "REST.", "Soap.", "Xml.", "Web.", "Bde.", "IBX.",
    "FireDAC.", "Androidapi.", "iOSapi.", "Macapi.",
    // Classic pre-namespace RTL/VCL units (Delphi ≤2007 and unit-scope
    // aliases) — exact unit names in canonical casing.
    "SysUtils", "Classes", "Windows", "Messages", "Graphics", "Controls",
    "Forms", "Dialogs", "StdCtrls", "ExtCtrls", "ComCtrls", "Menus",
    "Buttons", "Grids", "DBGrids", "DB", "DBTables", "Registry", "IniFiles",
    "ShellAPI", "ShlObj", "ActiveX", "ComObj", "OleCtrls", "Math",
    "StrUtils", "DateUtils", "Variants", "TypInfo", "SyncObjs", "Contnrs",
    "Masks", "Printers", "Clipbrd", "MMSystem", "WinSock", "WinInet",
    "WinProcs", "WinTypes", "Jpeg", "ExtDlgs", "FileCtrl", "CommCtrl",
    "ToolWin", "ImgList", "ActnList", "StdActns", "Types", "UITypes",
    "ZLib", "TabNotBk", "Mask", "Spin", "CheckLst", "OleAuto", "DdeMan",
    // Old freeware writes `uses wintypes, winprocs;` — lowercase variants,
    // but ONLY for names no other ecosystem would use as a bare import
    // (prefixes aggregate globally; lowercase `classes`/`types`/`db` would
    // shadow legit bare local imports in TS/JS repos).
    "sysutils", "stdctrls", "extctrls", "comctrls", "dbgrids", "dbtables",
    "inifiles", "shellapi", "shlobj", "comobj", "olectrls", "strutils",
    "dateutils", "typinfo", "syncobjs", "contnrs", "clipbrd", "mmsystem",
    "winsock", "wininet", "winprocs", "wintypes", "extdlgs", "filectrl",
    "commctrl", "toolwin", "imglist", "actnlist", "stdactns", "tabnotbk",
    "checklst", "oleauto", "ddeman", "uitypes",
    // Indy — flat (dotless) unit names, most-used components.
    "IdHTTP", "IdTCPClient", "IdTCPServer", "IdTCPConnection", "IdSSL",
    "IdSSLOpenSSL", "IdGlobal", "IdBaseComponent", "IdComponent", "IdSMTP",
    "IdPOP3", "IdFTP", "IdMessage", "IdContext", "IdHTTPServer",
    "IdCustomHTTPServer", "IdUDPClient", "IdUDPServer", "IdSocketHandle",
    "IdIOHandler", "IdExplicitTLSClientServerBase", "IdAntiFreeze",
  ],
  frameworkRules: pascalFrameworkRules,
  // The DFM→handler UI bridge joins .dfm event wirings to form methods, so
  // discovering dfm files must load this plugin's resolvers too.
  dispatchLanguages: ["dfm"],
};

export const dfmManifest: LanguagePluginManifest = {
  language: "dfm",
  family: "pascal",
  // `object frmLaerer: TfrmLaerer` describes the form the .pas unit declares.
  designFormat: true,
  parsing: "custom",
  // .lfm = Lazarus, .fmx = FireMonkey — same object syntax (both always
  // text), same parser. Only classic .dfm can be a binary TPF0 stream.
  extensions: [".dfm", ".lfm", ".fmx"],
  importTarget: false,
};
