# ---------------------------------------------------------------------------
# dupefinder — VDF.Core wrapper service. See ../vdf_jellyfin_gate_handoff.md
# for the integration decision and VENDORED.md for where VDF.Core came from.
#
# Two-stage build, the same shape as upstream's own VDF.CLI/Dockerfile. This
# is the ONE place in the whole jellyfin-gate stack that isn't Alpine: the
# rest of the project's Dockerfile uses `apk add ffmpeg` on an Alpine base,
# but VDF.Core's dependency graph (FFmpeg.AutoGen, Mono.Posix.NETStandard,
# Microsoft.ML.OnnxRuntime.Managed) is what upstream builds and tests against
# glibc, not musl. This service never enables the settings that would
# actually exercise those (UseNativeFfmpegBinding, UseAiMatching,
# ExcludeHardLinks all stay false/default — see Program.cs and
# DupeFinder.Api.csproj), but Alpine is the wrong base to find a musl
# incompatibility on for a dependency this deep, for the size savings it
# would buy on a service that isn't in the hot path.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY VDF.Core/VDF.Core.csproj VDF.Core/
COPY DupeFinder.Api/DupeFinder.Api.csproj DupeFinder.Api/
RUN dotnet restore DupeFinder.Api/DupeFinder.Api.csproj
COPY VDF.Core/ VDF.Core/
COPY DupeFinder.Api/ DupeFinder.Api/
RUN dotnet publish DupeFinder.Api/DupeFinder.Api.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
# VDF.Core shells out to whatever ffmpeg/ffprobe it finds on PATH (see
# FFTools/FFToolsUtils.cs's ScanPathDirs) rather than linking against them —
# no native binding as long as UseNativeFfmpegBinding stays false.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["./DupeFinder.Api"]
