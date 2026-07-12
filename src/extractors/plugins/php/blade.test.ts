import { describe, it, expect } from "vitest";
import { extractBladeScreens, extractBladeInteractiveElements } from "./blade.js";

/**
 * Blade templates reached the PHP plugin (they are .php) but contributed no
 * screens and no interactive elements — a Laravel app's UI tier was invisible.
 */
const TEMPLATE = `@extends('layouts.app')

@section('title', 'Product Catalog')

@section('content')
    <form action="/api/products" method="post">
        @csrf
        <button type="submit" onclick="submitSearch()">Search</button>
    </form>
    <button onclick="addToCart({{ $product->id }})">Add</button>
    <!-- <button onclick="commentedOut()">nope</button> -->
@endsection
`;

describe("Blade screens", () => {
  it("emits one blade-view screen per .blade.php with the @section title", () => {
    const screens = extractBladeScreens(TEMPLATE, "resources/views/shop/catalog.blade.php");
    expect(screens).toHaveLength(1);
    expect(screens[0]!.name).toBe("catalog");
    expect(screens[0]!.formType).toBe("blade-view");
    expect(screens[0]!.caption).toBe("Product Catalog");
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
    expect(els.some((e) => e.handler === "addToCart")).toBe(true);
    expect(els.some((e) => e.handler === "commentedOut")).toBe(false);
  });

  it("stays silent on plain PHP class files (no Blade markers)", () => {
    const SRC = `<?php
class ProductController {
  // has the word onclick="x()" only inside a comment-free class? no markers.
  public function index() { return Product::all(); }
}`;
    expect(extractBladeInteractiveElements(SRC)).toEqual([]);
  });
});
