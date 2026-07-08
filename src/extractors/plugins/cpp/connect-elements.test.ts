import { describe, it, expect } from "vitest";
import { extractCppConnectElements } from "./connect-elements.js";

const els = (src: string) => extractCppConnectElements(src.split("\n"));

describe("extractCppConnectElements", () => {
  it("extracts a multi-line connect with preprocessor branches (Mixxx shape)", () => {
    const out = els(`
DlgPrefAutoDJ::DlgPrefAutoDJ(QWidget* pParent) {
    connect(RequeueIgnoreCheckBox,
#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
            &QCheckBox::checkStateChanged,
#else
            &QCheckBox::stateChanged,
#endif
            this,
            &DlgPrefAutoDJ::slotToggleRequeueIgnore);
}
    `);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      element: "button",
      event: "checkStateChanged",
      handler: "slotToggleRequeueIgnore",
      component: "QCheckBox",
    });
  });

  it("extracts single-line new-style and legacy SIGNAL/SLOT connects", () => {
    const out = els(`
    connect(pushButtonApply, &QPushButton::clicked, this, &DlgPrefEQ::slotApply);
    connect(ui->comboBoxDevice, SIGNAL(currentIndexChanged(int)), this, SLOT(slotDeviceChanged(int)));
    `);
    expect(out.map((e) => [e.event, e.handler, e.element])).toEqual([
      ["clicked", "slotApply", "button"],
      ["currentIndexChanged", "slotDeviceChanged", "select"],
    ]);
  });

  it("skips lambdas, non-UI signals, and weak signals on non-widget receivers", () => {
    const out = els(`
    connect(pushButtonClose, &QPushButton::clicked, this, [this] { close(); });
    connect(m_pWorker, &Worker::finished, this, &Dlg::slotDone);
    connect(m_pControl, &ControlObject::valueChanged, this, &EngineBuffer::slotControlChanged);
    connect(volumeSlider, &QSlider::valueChanged, this, &DlgPref::slotVolume);
    `);
    // Only the slider (weak signal + widget-shaped receiver) survives.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: "valueChanged", handler: "slotVolume", element: "input" });
  });

  it("does not fire on disconnect() or member .connect() calls", () => {
    const out = els(`
    disconnect(pushButtonApply, &QPushButton::clicked, this, &Dlg::slotApply);
    m_socket.connect(hostSpinBox, &QSpinBox::valueChanged, this, &Dlg::slotPort);
    `);
    expect(out).toEqual([]);
  });
});
