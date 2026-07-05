import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** CPAN (Perl) package recognition. Classified by module name. */
export const cpanPackages: readonly KnownPackageRule[] = [
  { names: ["Catalyst", "Catalyst::Runtime"], category: "framework", framework: { id: "catalyst", name: "Catalyst" } },
  { names: ["Mojolicious"], category: "framework", framework: { id: "mojolicious", name: "Mojolicious" } },
  { names: ["Dancer", "Dancer2"], category: "framework", framework: { id: "dancer", name: "Dancer" } },
  { names: ["Plack"], category: "framework" },
  { names: ["DBI"], category: "database" },
  { names: ["DBIx::Class"], category: "orm" },
  { names: ["Moose", "Moo"], category: "util" },
  { names: ["LWP::UserAgent", "HTTP::Tiny", "Mojo::UserAgent"], category: "http" },
  { names: ["Test::More", "Test::Simple", "Test2::Suite"], category: "testing" },
];
