import { describe, it, expect } from "vitest";
import { pluginFor } from "../registry.js";

const preprocess = (language: "scala" | "perl", src: string, path: string) => pluginFor(language)!.preprocess!(src, path);

describe("Scala .sc", () => {
  it("keeps Scala scripts and Mill builds", () => {
    expect(preprocess("scala", "//> using scala 3.4\n@main def run() = println(1)\n", "run.sc")).toBeNull();
    expect(preprocess("scala", "import mill._, scalalib._\nobject app extends ScalaModule\n", "build.sc")).toBeNull();
  });

  it("skips SuperCollider", () => {
    expect(preprocess("scala", "MyCls : Object {\n  *new { ^super.new }\n}\n", "Classes/MyCls.sc")).toEqual({ skip: expect.any(String) });
    expect(preprocess("scala", "(\nvar x = 5;\nSynthDef(\\beep, { Out.ar(0, SinOsc.ar(440)) }).add;\n)\n", "session.sc")).toEqual({ skip: expect.any(String) });
  });

  it("never looks at .scala files", () => {
    expect(preprocess("scala", "anything at all", "src/A.scala")).toBeNull();
  });
});

describe("Perl .cgi", () => {
  it("keeps Perl CGI scripts", () => {
    expect(preprocess("perl", "#!/usr/bin/perl -w\nuse CGI;\n", "cgi-bin/search.cgi")).toBeNull();
    expect(preprocess("perl", "#!/usr/bin/env perl\nprint 1;\n", "cgi-bin/a.cgi")).toBeNull();
    expect(preprocess("perl", "use strict;\nmy $q = CGI->new;\n", "cgi-bin/b.cgi")).toBeNull();
  });

  it("skips CGI programs in other languages and binaries", () => {
    expect(preprocess("perl", "#!/usr/bin/python3\nimport cgi\n", "cgi-bin/c.cgi")).toEqual({ skip: expect.any(String) });
    expect(preprocess("perl", "#!/bin/sh\necho ok\n", "cgi-bin/d.cgi")).toEqual({ skip: expect.any(String) });
    expect(preprocess("perl", "\u007fELF\u0002\u0001\u0001\u0000\u0000", "cgi-bin/e.cgi")).toEqual({ skip: "binary CGI program" });
  });

  it("never looks at .pl / .pm / .t files", () => {
    expect(preprocess("perl", "#!/usr/bin/python3\n", "t/basic.t")).toBeNull();
  });
});
