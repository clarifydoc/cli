#!/bin/sh
# Restore NuGet packages before starting OmniSharp
# OmniSharp needs a restored project to build the Roslyn workspace
cd /workspace
dotnet restore --verbosity quiet 2>/dev/null || true
exec /opt/omnisharp/OmniSharp --languageserver "$@"
