#!/bin/sh
# Roslyn language server — serves both C# and VB.NET.
# Image uses misterkiem/roslyn-plusvb fork which patches VB libraries into the
# official Microsoft.CodeAnalysis.LanguageServer (C# support is upstream).
# Needs a restored project (.csproj/.vbproj) for cross-file symbol resolution.
cd /workspace
# EnableWindowsTargeting=true lets WinForms/net*-windows projects restore on Linux
dotnet restore -p:EnableWindowsTargeting=true --verbosity quiet 2>/dev/null || true
SERVER_DLL="$(find /opt/roslyn -maxdepth 3 -name 'Microsoft.CodeAnalysis.LanguageServer.dll' | head -n1)"
if [ -z "$SERVER_DLL" ]; then
  echo "Microsoft.CodeAnalysis.LanguageServer.dll not found under /opt/roslyn" >&2
  exit 1
fi
mkdir -p /tmp/roslyn-logs
exec dotnet "$SERVER_DLL" \
  --logLevel=Information \
  --extensionLogDirectory=/tmp/roslyn-logs \
  --autoLoadProjects \
  --stdio \
  "$@"
