import { describe, it, expect } from "vitest";
import { qtuiSpec } from "./index.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ui version="4.0">
 <class>DlgControllerLearning</class>
 <widget class="QDialog" name="DlgControllerLearning">
  <property name="geometry">
   <rect>
    <x>0</x>
    <y>0</y>
    <width>542</width>
    <height>369</height>
   </rect>
  </property>
  <property name="windowTitle">
   <string>Controller Learning Wizard</string>
  </property>
  <layout class="QGridLayout" name="gridLayout">
   <item>
    <widget class="QStackedWidget" name="stackedWidget">
     <widget class="QWidget" name="page1Choose">
      <widget class="QPushButton" name="pushButtonStartLearn">
       <property name="text">
        <string>Learn</string>
       </property>
      </widget>
      <widget class="QLineEdit" name="lineEditFilter"/>
      <widget class="QLabel" name="labelHint"/>
     </widget>
    </widget>
   </item>
  </layout>
 </widget>
 <connections>
  <connection>
   <sender>pushButtonStartLearn</sender>
   <signal>clicked()</signal>
   <receiver>DlgControllerLearning</receiver>
   <slot>slotStartLearn()</slot>
  </connection>
 </connections>
</ui>`;

const lines = SAMPLE.split("\n");

describe("qtuiSpec", () => {
  it("builds one screen from the form with class name, caption, and tree", () => {
    const screens = qtuiSpec.extractScreens!(lines, "src/controllers/dlgcontrollerlearning.ui", []);
    expect(screens).toHaveLength(1);
    const s = screens[0]!;
    expect(s.name).toBe("DlgControllerLearning");
    expect(s.formType).toBe("QDialog");
    expect(s.caption).toBe("Controller Learning Wizard");
    expect(s.dimensions).toEqual({ width: 542, height: 369 });
    const stacked = s.components[0]!;
    expect(stacked.componentType).toBe("QStackedWidget");
    expect(stacked.category).toBe("navigation");
    const page = stacked.children[0]!;
    const types = page.children.map((c) => c.componentType);
    expect(types).toEqual(["QPushButton", "QLineEdit", "QLabel"]);
    const learn = page.children.find((c) => c.name === "pushButtonStartLearn")!;
    expect(learn.category).toBe("action");
    expect(learn.events).toContain("clicked");
  });

  it("turns Designer connections into interactive elements with the C++ slot as handler", () => {
    const els = qtuiSpec.extractInteractiveElements!(lines);
    const wired = els.find((e) => e.handler === "slotStartLearn")!;
    expect(wired).toMatchObject({
      element: "button",
      event: "clicked",
      component: "QPushButton",
    });
    // The unwired lineEdit isn't surfaced; unwired buttons would be.
    expect(els.some((e) => e.handler === "lineEditFilter")).toBe(false);
  });
});
