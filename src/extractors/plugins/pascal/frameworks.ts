import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasDelphiDep, usesDelphiUnit } from "../shared/project-info-queries.js";

/**
 * Delphi / Lazarus framework rules — uses-clause units and project files.
 * Family plugin: attached to `pascalMeta` only (never the .dfm resource meta).
 */
export const pascalFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "vcl",
    name: "VCL",
    // Unit scoping (`Vcl.Forms`) arrived in Delphi XE2; every codebase older
    // than that — and plenty newer, since the bare names still compile — writes
    // `uses Forms, Controls, StdCtrls`. Matching only the scoped spelling misses
    // the entire pre-XE2 world, which is most of the Delphi still in service.
    check: (info) =>
      hasDelphiDep(info, "Vcl.Forms") || hasDelphiDep(info, "Vcl.Controls") ||
      usesDelphiUnit(info, "Forms", "Controls", "StdCtrls", "ExtCtrls", "ComCtrls"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "fmx",
    name: "FireMonkey (FMX)",
    check: (info) => hasDelphiDep(info, "FMX.Forms") || hasDelphiDep(info, "FMX.Controls"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "datasnap",
    name: "DataSnap",
    check: (info) => hasDelphiDep(info, "Datasnap.DSServer") || hasDelphiDep(info, "Datasnap.DSHTTPWebBroker"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "rad-server",
    name: "RAD Server",
    check: (info) => hasDelphiDep(info, "EMS.Services") || hasDelphiDep(info, "EMSHosting."),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "fibplus",
    name: "FIBPlus (Firebird/InterBase)",
    check: (info) =>
      hasDelphiDep(info, "pFIB") ||
      usesDelphiUnit(info, "FIBDataSet", "FIBQuery", "FIBDatabase", "FIBSQLMonitor"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "ibx",
    name: "InterBase Express (IBX)",
    check: (info) => hasDelphiDep(info, "IBX.") || usesDelphiUnit(info, "IBDatabase", "IBQuery", "IBCustomDataSet"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "firedac",
    name: "FireDAC",
    check: (info) => hasDelphiDep(info, "FireDAC."),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "devexpress-vcl",
    name: "DevExpress VCL (ExpressQuantumGrid)",
    check: (info) =>
      hasDelphiDep(info, "cxGrid") || hasDelphiDep(info, "cxEdit") ||
      hasDelphiDep(info, "cxControls") || hasDelphiDep(info, "dxSkin") ||
      hasDelphiDep(info, "cxLookAndFeel"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "jvcl",
    name: "JEDI VCL (JVCL)",
    check: (info) => hasDelphiDep(info, "Jv") && usesDelphiUnit(info, "JvComponentBase", "JvMemoryDataset", "JvGIF", "JvExControls"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "indy",
    name: "Indy",
    check: (info) =>
      usesDelphiUnit(info, "IdHTTP", "IdTCPClient", "IdTCPServer", "IdSMTP", "IdPOP3", "IdFTP", "IdBaseComponent", "IdHTTPServer"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "delphi",
    name: "Delphi",
    check: (info) => info.dprojFiles.length > 0,
    detectedVia: ".dproj file",
  },
  {
    id: "lazarus",
    name: "Lazarus",
    check: (info) => info.lpiFiles.length > 0,
    detectedVia: ".lpi file",
  },
];
