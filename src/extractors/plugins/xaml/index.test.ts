import { describe, it, expect } from "vitest";
import { xamlSpec, parseXaml } from "./index.js";

// Avalonia style: multi-line opening tags, x:Class, namespaced components,
// property elements, resources, and a DataTemplate with a wired button.
const SAMPLE = `<ui:PhControl
    x:Class="ImageGlass.Tools.ColorPickerToolControl"
    xmlns="https://github.com/avaloniaui"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
    xmlns:ui="using:ImageGlass.UI"
    d:DesignHeight="450"
    d:DesignWidth="800"
    x:Name="Root">

    <ui:PhControl.Resources>
        <SolidColorBrush x:Key="Accent" Color="Red" />
    </ui:PhControl.Resources>

    <!-- a comment with <Button Click="NotReal_Click" /> inside -->

    <StackPanel Orientation="Horizontal">
        <StackPanel.Background>
            <VisualBrush TileMode="Tile" />
        </StackPanel.Background>

        <TextBlock Text="Current color" />
        <Button
            x:Name="BtnCopy"
            Content="Copy"
            Click="ButtonCopy_Click" />
        <ui:PhMenuItem Click="MainMenuItem_Click" LangKey="FrmMain_MnuOpenFile" />
        <Button Content="Save" Command="{CompiledBinding SaveCommand}" />
        <ItemsControl>
            <ItemsControl.ItemTemplate>
                <DataTemplate>
                    <ToggleButton Click="GalleryItem_Click" />
                </DataTemplate>
            </ItemsControl.ItemTemplate>
        </ItemsControl>
    </StackPanel>
</ui:PhControl>`;

const lines = SAMPLE.split("\n");

describe("parseXaml", () => {
  it("builds a tree with property elements transparent", () => {
    const { root } = parseXaml(SAMPLE);
    expect(root!.name).toBe("PhControl");
    expect(root!.attrs["x:Class"]).toBe("ImageGlass.Tools.ColorPickerToolControl");
    const stack = root!.children.find((c) => c.name === "StackPanel")!;
    // VisualBrush (inside <StackPanel.Background>) attaches under StackPanel;
    // DataTemplate content attaches under ItemsControl.
    const items = stack.children.find((c) => c.name === "ItemsControl")!;
    const template = items.children.find((c) => c.name === "DataTemplate")!;
    expect(template.children[0]!.name).toBe("ToggleButton");
  });
});

describe("xamlSpec screens", () => {
  it("names the screen from x:Class and sizes from design dims", () => {
    const screens = xamlSpec.extractScreens!(lines, "source/Lib/Tools/ColorPickerToolControl.axaml", []);
    expect(screens).toHaveLength(1);
    const s = screens[0]!;
    expect(s.name).toBe("ColorPickerToolControl");
    expect(s.formType).toBe("PhControl");
    expect(s.dimensions).toEqual({ width: 800, height: 450 });
    const stack = s.components.find((c) => c.componentType === "StackPanel")!;
    expect(stack.category).toBe("container");
    const btn = stack.children.find((c) => c.name === "BtnCopy")!;
    expect(btn.category).toBe("action");
    expect(btn.events).toContain("Click");
    // Brushes never enter the component tree.
    expect(JSON.stringify(s.components)).not.toContain("VisualBrush");
  });

  it("skips resource-dictionary files", () => {
    const res = `<ResourceDictionary xmlns="https://github.com/avaloniaui"><SolidColorBrush x:Key="A" /></ResourceDictionary>`;
    expect(xamlSpec.extractScreens!(res.split("\n"), "Styles/Icons.axaml", [])).toHaveLength(0);
  });
});

describe("xamlSpec interactive elements", () => {
  it("captures event attributes and command bindings, not comments", () => {
    const els = xamlSpec.extractInteractiveElements!(lines);
    const handlers = els.map((e) => e.handler);
    expect(handlers).toContain("ButtonCopy_Click");
    expect(handlers).toContain("MainMenuItem_Click");
    expect(handlers).toContain("GalleryItem_Click");
    expect(handlers).toContain("SaveCommand");
    expect(handlers).not.toContain("NotReal_Click");

    const copy = els.find((e) => e.handler === "ButtonCopy_Click")!;
    expect(copy.element).toBe("button");
    expect(copy.event).toBe("Click");
    expect(copy.component).toBe("Button");

    const save = els.find((e) => e.handler === "SaveCommand")!;
    expect(save.event).toBe("command");
  });
});

describe("xamlSpec sub-components", () => {
  it("collects namespaced component tags only", () => {
    const subs = xamlSpec.extractSubComponents!(lines);
    const names = subs.map((s) => s.name);
    expect(names).toContain("PhMenuItem");
    expect(names).toContain("PhControl");
    expect(names).not.toContain("StackPanel");
    expect(names).not.toContain("Button");
  });
});

describe("XAML view model discovery", () => {
  const screenOf = (xaml: string) => xamlSpec.extractScreens!(xaml.split("\n"), "Views/ClubView.xaml", [])?.[0];
  it("reads a DataContext element on the root", () => {
    const s = screenOf(`<UserControl x:Class="App.ClubView" xmlns:vm="clr-namespace:App.ViewModels">
  <UserControl.DataContext><vm:ClubViewModel/></UserControl.DataContext>
  <StackPanel><Button Command="{Binding SaveCommand}"/></StackPanel>
</UserControl>`);
    expect(s?.viewModel).toBe("ClubViewModel");
  });
  it("reads a design-time instance", () => {
    const s = screenOf(`<UserControl x:Class="App.ClubView" d:DataContext="{d:DesignInstance Type=vm:ClubViewModel, IsDesignTimeCreatable=True}"><Grid/></UserControl>`);
    expect(s?.viewModel).toBe("ClubViewModel");
  });
  it("does not take a nested control's own DataContext for the view's", () => {
    const s = screenOf(`<UserControl x:Class="App.ClubView"><StackPanel><ListBox.DataContext><vm:PlayerViewModel/></ListBox.DataContext></StackPanel></UserControl>`);
    expect(s?.viewModel).toBeUndefined();
  });
});

describe("Prism AutoWireViewModel", () => {
  const view = (cls: string, attr: string) => `<UserControl x:Class="Club.Views.${cls}"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    xmlns:prism="http://prismlibrary.com/"
    ${attr}>
  <Button Command="{Binding SaveCommand}" />
</UserControl>`;
  const vm = (cls: string, attr: string) => xamlSpec.extractScreens!(view(cls, attr).split("\n"), `Views/${cls}.xaml`)[0]!.viewModel;

  it("wires ClubView to ClubViewModel by convention", () => {
    expect(vm("ClubView", 'prism:ViewModelLocator.AutoWireViewModel="True"')).toBe("ClubViewModel");
    expect(vm("SquadPage", 'prism:ViewModelLocator.AutoWireViewModel="true"')).toBe("SquadViewModel");
  });

  it("wires nothing when the locator is off or absent", () => {
    expect(vm("ClubView", 'prism:ViewModelLocator.AutoWireViewModel="False"')).toBeUndefined();
    expect(vm("ClubView", "")).toBeUndefined();
  });
});
