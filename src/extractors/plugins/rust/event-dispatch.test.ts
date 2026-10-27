import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { AfDispatchResolver } from "./event-dispatch.js";

describe("af-dispatch (an event-dispatch library)", () => {
  it("joins a Flutter call of a generated event class to the Rust handler registered for it", () => {
    const eventMap = extractWithRegex(`use crate::event_handler::*;
pub fn init(folder: Weak<FolderManager>) -> AFPlugin {
  AFPlugin::new()
    .name("Flowy-Folder")
    .event(FolderEvent::CreateView, create_view_handler)
    .event(
      FolderEvent::ReadCurrentWorkspace,
      read_current_workspace_handler,
    )
}`, "frontend/rust-lib/flowy-folder/src/event_map.rs", "rust");
    expect(eventMap.messageHandlers).toEqual([
      { message: "FolderEvent::CreateView", handler: "create_view_handler", line: 5 },
      { message: "FolderEvent::ReadCurrentWorkspace", handler: "read_current_workspace_handler", line: 6 },
    ]);
    const handlers = extractWithRegex(`pub(crate) async fn create_view_handler(data: AFPluginData<CreateViewPayloadPB>) -> DataResult<ViewPB, FlowyError> {
  let view = folder.create_view_with_params(params).await?;
  data_result_ok(view)
}
pub(crate) async fn read_current_workspace_handler() -> DataResult<WorkspacePB, FlowyError> {
  Ok(())
}`, "frontend/rust-lib/flowy-folder/src/event_handler.rs", "rust");
    const dart = extractWithRegex(`class ViewBackendService {
  static Future<FlowyResult<ViewPB, FlowyError>> createView({required String name}) {
    final payload = CreateViewPayloadPB.create()..name = name;
    return FolderEventCreateView(payload).send();
  }
}`, "frontend/league_flutter/lib/workspace/application/view/view_service.dart", "dart");
    const links = new AfDispatchResolver().resolve([eventMap, handlers, dart]);
    expect(links.map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "ViewBackendService.createView -FolderEventCreateView-> frontend/rust-lib/flowy-folder/src/event_handler.rs::create_view_handler",
    ]);
  });
});
