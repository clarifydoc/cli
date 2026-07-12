import { describe, it, expect } from "vitest";
import {
  extractWinFormsInteractiveElements,
  extractWinFormsScreens,
} from "./winforms-ui.js";

// Modern (VS2022+) Designer style: no `this.`, single-line AddRange.
const MODERN_DESIGNER = `namespace ImageGlass
{
    partial class FrmMain
    {
        private System.ComponentModel.IContainer components = null;

        private void InitializeComponent()
        {
            Toolbar = new ModernToolbar();
            MnuMain = new ModernMenu(components);
            MnuFile = new ToolStripMenuItem();
            MnuOpenFile = new ToolStripMenuItem();
            MnuSave = new ToolStripMenuItem();
            PicMain = new ImageGlass.Viewer.DXCanvas();
            PanBottom = new TableLayoutPanel();
            BtnApply = new ModernButton();
            SuspendLayout();
            Toolbar.ItemClicked += Toolbar_ItemClicked;
            MnuMain.Items.AddRange(new ToolStripItem[] { MnuFile });
            MnuFile.DropDownItems.AddRange(new ToolStripItem[] { MnuOpenFile, MnuSave });
            MnuOpenFile.Click += MnuOpenFile_Click;
            MnuSave.Click += MnuSave_Click;
            PicMain.Location = new Point(0, 32);
            PicMain.Size = new Size(1300, 700);
            PanBottom.Controls.Add(BtnApply, 0, 1);
            BtnApply.Text = "Apply";
            BtnApply.Click += BtnApply_Click;
            ClientSize = new Size(1300, 800);
            Controls.Add(PicMain);
            Controls.Add(Toolbar);
            Controls.Add(PanBottom);
            Name = "FrmMain";
            Text = "ImageGlass";
        }

        #endregion

        private ToolStripSeparator toolStripMenuItem1;
    }
}`;

// Legacy Designer style: `this.` receivers + `new System.EventHandler(...)`.
const LEGACY_DESIGNER = `namespace App
{
    partial class FrmLegacy
    {
        private void InitializeComponent()
        {
            this.button1 = new System.Windows.Forms.Button();
            this.groupBox1 = new System.Windows.Forms.GroupBox();
            this.button1.Click += new System.EventHandler(this.button1_Click);
            this.groupBox1.Controls.Add(this.button1);
            this.Controls.Add(this.groupBox1);
            this.ClientSize = new System.Drawing.Size(400, 300);
            this.Text = "Legacy Form";
        }
    }
}`;

describe("extractWinFormsInteractiveElements", () => {
  it("captures modern-style event wirings with handler and component", () => {
    const els = extractWinFormsInteractiveElements(MODERN_DESIGNER);
    const byHandler = new Map(els.map((e) => [e.handler, e]));
    expect(byHandler.has("MnuOpenFile_Click")).toBe(true);
    expect(byHandler.has("Toolbar_ItemClicked")).toBe(true);
    const open = byHandler.get("MnuOpenFile_Click")!;
    expect(open.event).toBe("Click");
    expect(open.element).toBe("button");
    expect(open.component).toBe("MnuOpenFile");
  });

  it("captures legacy new EventHandler(this.x) style", () => {
    const els = extractWinFormsInteractiveElements(LEGACY_DESIGNER);
    expect(els).toHaveLength(1);
    expect(els[0]!.handler).toBe("button1_Click");
    expect(els[0]!.event).toBe("Click");
  });

  it("skips lifecycle events and non-UI subscriptions", () => {
    const src = `class Svc {
      void Wire() {
        Load += FrmMain_Load;
        conn.StateChange += Conn_StateChange;
        AppDomain.CurrentDomain.ProcessExit += OnExit;
        watcher.PropertyChanged += OnPropChanged;
      }
    }`;
    expect(extractWinFormsInteractiveElements(src)).toHaveLength(0);
  });

  it("keeps weak events only on control-shaped receivers", () => {
    const src = `class F {
      void Wire() {
        MnuMain.Opening += MnuMain_Opening;
        session.Opening += Session_Opening;
      }
    }`;
    const els = extractWinFormsInteractiveElements(src);
    expect(els).toHaveLength(1);
    expect(els[0]!.handler).toBe("MnuMain_Opening");
  });

  it("skips lambda handlers", () => {
    const src = `BtnGo.Click += (s, e) => DoThing();`;
    expect(extractWinFormsInteractiveElements(src)).toHaveLength(0);
  });
});

describe("extractWinFormsScreens", () => {
  it("builds one screen with caption, dimensions, and nested tree", () => {
    const screens = extractWinFormsScreens(MODERN_DESIGNER, "v9/ImageGlass/FrmMain.Designer.cs");
    expect(screens).toHaveLength(1);
    const s = screens[0]!;
    expect(s.name).toBe("FrmMain");
    expect(s.caption).toBe("ImageGlass");
    expect(s.dimensions).toEqual({ width: 1300, height: 800 });

    const names = new Map(s.components.map((c) => [c.name, c]));
    // Form children (bare Controls.Add) are roots.
    expect(names.has("PicMain")).toBe(true);
    expect(names.has("Toolbar")).toBe(true);
    // MnuMain is never Controls.Add'ed → surfaces as a root with its menu tree.
    const mnuMain = names.get("MnuMain")!;
    expect(mnuMain.children.map((c) => c.name)).toEqual(["MnuFile"]);
    expect(mnuMain.children[0]!.children.map((c) => c.name)).toEqual(["MnuOpenFile", "MnuSave"]);
    // TableLayoutPanel Add with extra args still nests.
    const pan = names.get("PanBottom")!;
    expect(pan.children.map((c) => c.name)).toEqual(["BtnApply"]);
    expect(pan.children[0]!.caption).toBe("Apply");
    expect(pan.children[0]!.events).toContain("Click");
    expect(pan.children[0]!.category).toBe("action");
  });

  it("handles legacy this.-prefixed style", () => {
    const screens = extractWinFormsScreens(LEGACY_DESIGNER, "App/FrmLegacy.Designer.cs");
    expect(screens).toHaveLength(1);
    const s = screens[0]!;
    expect(s.name).toBe("FrmLegacy");
    expect(s.caption).toBe("Legacy Form");
    expect(s.dimensions).toEqual({ width: 400, height: 300 });
    const group = s.components.find((c) => c.name === "groupBox1")!;
    expect(group.category).toBe("container");
    expect(group.children.map((c) => c.name)).toEqual(["button1"]);
  });

  it("ignores non-Designer files and resx codegen", () => {
    expect(extractWinFormsScreens(MODERN_DESIGNER, "v9/ImageGlass/FrmMain.cs")).toHaveLength(0);
    const resx = `namespace App.Properties {
      internal class Resources {
        private static global::System.Resources.ResourceManager resourceMan;
      }
    }`;
    expect(extractWinFormsScreens(resx, "App/Properties/Resources.Designer.cs")).toHaveLength(0);
  });

  it("records interactive positions from Location + Size", () => {
    const screens = extractWinFormsScreens(MODERN_DESIGNER, "v9/ImageGlass/FrmMain.Designer.cs");
    const pic = screens[0]!.components.find((c) => c.name === "PicMain")!;
    expect(pic.position).toEqual({ left: 0, top: 32, width: 1300, height: 700 });
  });
});
