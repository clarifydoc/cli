import { describe, it, expect } from "vitest";
import { bladeImports, extractBladeScreens, extractBladeInteractiveElements } from "./blade.js";
import { extractHtmlInteractiveElements } from "../html/index.js";

/**
 * Blade templates reached the PHP plugin (they are .php) but contributed no
 * screens and no interactive elements — a Laravel app's UI tier was invisible.
 */
const TEMPLATE = `@extends('layouts.app')

@section('title', 'Part Catalog')

@section('content')
    <form action="/api/parts" method="post">
        @csrf
        <button type="submit" onclick="submitSearch()">Search</button>
    </form>
    <button onclick="addToGarage({{ $part->id }})">Add</button>
    <!-- <button onclick="commentedOut()">nope</button> -->
@endsection
`;

describe("Blade screens", () => {
  it("emits one blade-view screen per .blade.php with the @section title", () => {
    const screens = extractBladeScreens(TEMPLATE, "resources/views/shop/catalog.blade.php");
    expect(screens).toHaveLength(1);
    expect(screens[0]!.name).toBe("catalog");
    expect(screens[0]!.formType).toBe("blade-view");
    expect(screens[0]!.caption).toBe("Part Catalog");
  });

  it("emits nothing for non-blade PHP files", () => {
    expect(extractBladeScreens(TEMPLATE, "app/Http/Controllers/X.php")).toEqual([]);
  });
});

describe("Blade interactive elements", () => {
  it("extracts forms and buttons with handlers via the html extractors", () => {
    const els = extractBladeInteractiveElements(TEMPLATE);
    expect(els.some((e) => e.element === "form")).toBe(true);
    expect(els.some((e) => e.handler === "submitSearch")).toBe(true);
    expect(els.some((e) => e.handler === "addToGarage")).toBe(true);
    expect(els.some((e) => e.handler === "commentedOut")).toBe(false);
  });

  it("stays silent on plain PHP class files (no Blade markers)", () => {
    const SRC = `<?php
class PartController {
  // has the word onclick="x()" only inside a comment-free class? no markers.
  public function index() { return Part::all(); }
}`;
    expect(extractBladeInteractiveElements(SRC)).toEqual([]);
  });
});

describe("what a Blade view loads", () => {
  it("imports its @vite scripts and the views it extends, includes and renders", () => {
    const view = `@extends('layout.session')
@section('content')
  <x-club.card :club="$club" />
  <x-slot name="footer">x</x-slot>
  @include('partials.club-form', ['club' => $club])
@endsection
@vite(['js/pages/clubs/show.js', 'sass/app.scss'])`;
    expect(bladeImports(view).map((i) => `${i.line} ${i.source}`)).toEqual([
      "7 js/pages/clubs/show.js",
      "1 layout/session.blade.php",
      "5 partials/club-form.blade.php",
      "3 components/club/card.blade.php",
    ]);
  });

  it("reads Alpine event directives as handlers, never a template dialect's own @attribute", () => {
    const els = extractHtmlInteractiveElements([`<button type="button" @click.prevent="relegate(club)">Go</button>`, `<input @bind="Name" />`]);
    expect(els.map((e) => `${e.event} ${e.handler}`)).toEqual(["onclick relegate", "input null"]);
  });
});
