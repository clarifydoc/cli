import { describe, it, expect } from "vitest";
import { attachCommandHandlers } from "./command-handlers.js";
import type { PropertyInfo } from "../../../types/analysis.js";

const prop = (name: string): PropertyInfo => ({ name, type: "ICommand", visibility: "public", isStatic: false, isReadonly: false });

describe("command properties", () => {
  const props = [prop("KeepCommand"), prop("DropCommand"), prop("SaveCommand"), prop("TwiceCommand"), prop("BodyCommand")];
  attachCommandHandlers(`{
    public ClubViewModel() {
      KeepCommand = new RelayCommand(Keep);
      DropCommand = new DelegateCommand(() => Drop());
      SaveCommand = new AsyncRelayCommand(async () => await Save(), CanSave);
      TwiceCommand = new RelayCommand(One); TwiceCommand = new RelayCommand(Two);
      BodyCommand = new RelayCommand(() => { a(); b(); });
    }
  }`, props);
  it("reads the method each is built over", () => {
    expect(props.map((p) => p.commandHandler)).toEqual(["Keep", "Drop", "Save", undefined, undefined]);
  });
});
