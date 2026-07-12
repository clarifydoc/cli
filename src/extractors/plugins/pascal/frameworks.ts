import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasDelphiDep } from "../shared/project-info-queries.js";

/**
 * Delphi / Lazarus framework rules — uses-clause units and project files.
 * Family plugin: attached to `pascalMeta` only (never the .dfm resource meta).
 */
export const pascalFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "vcl",
    name: "VCL",
    check: (info) => hasDelphiDep(info, "Vcl.Forms") || hasDelphiDep(info, "Vcl.Controls"),
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
