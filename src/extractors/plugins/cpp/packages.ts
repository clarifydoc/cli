import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * Native C/C++ package recognition (vcpkg + Conan; classified by name).
 * Shared by the C and C++ metas — classification is by name, so the registry's
 * global map covers both regardless of which meta contributes it.
 */
export const nativePackages: readonly KnownPackageRule[] = [
  // ── Frameworks / app ──
  { names: ["qt", "qt5", "qt6", "qtbase"], category: "frontend", framework: { id: "qt", name: "Qt" } },
  { names: ["poco"], category: "framework", framework: { id: "poco", name: "POCO" } },
  // ── HTTP ──
  { names: ["curl", "libcurl", "cpr", "cpp-httplib", "httplib"], category: "http" },
  // ── Serialization ──
  { names: ["protobuf", "nlohmann-json", "jsoncpp", "rapidjson", "flatbuffers", "yaml-cpp", "capnproto"], category: "serialization" },
  // ── gRPC ──
  { names: ["grpc"], category: "grpc" },
  // ── Logging ──
  { names: ["spdlog", "glog", "log4cxx"], category: "logging" },
  // ── Testing ──
  { names: ["gtest", "googletest", "gmock", "catch2", "doctest", "boost-test"], category: "testing" },
  // ── UI / graphics ──
  { names: ["sdl2", "sfml", "glfw3", "imgui", "wxwidgets"], category: "ui" },
  // ── Database ──
  { names: ["sqlite3", "libpq", "libpqxx", "soci", "hiredis"], category: "database" },
  // ── Utility / math ──
  { names: ["fmt", "abseil", "eigen3", "opencv", "openssl", "zlib", "tbb", "range-v3"], category: "util" },
];
